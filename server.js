const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffprobeInstaller = require("@ffprobe-installer/ffprobe");
const path = require("path");

const ffmpegDir  = path.dirname(ffmpegInstaller.path);
const ffprobeDir = path.dirname(ffprobeInstaller.path);
process.env.PATH = `${ffmpegDir}:${ffprobeDir}:${process.env.PATH}`;

const express      = require("express");
const multer       = require("multer");
const cors         = require("cors");
const fs           = require("fs");
const { execFile } = require("child_process");
const crypto       = require("crypto");
const { getUploadInfo, recordUpload } = require("./upstash");

const PREMIUM_UIDS = require("./premium-check.js");

const FREE_LIMIT_BYTES    = 70  * 1024 * 1024;
const PREMIUM_LIMIT_BYTES = 120 * 1024 * 1024;

function getTier(uid) {
  const isPremium = !!uid && PREMIUM_UIDS.includes(String(uid));
  return {
    tier:       isPremium ? "premium" : "free",
    limitBytes: isPremium ? PREMIUM_LIMIT_BYTES : FREE_LIMIT_BYTES,
    limitMB:    isPremium ? 120 : 70,
  };
}

// ── Patcher routing ────────────────────────────────────────────────
const PATCHER_MAP = {
  bypass:    process.env.PATCHER_BYPASS    || "patcher_bypass.js",
  timescale: process.env.PATCHER_TIMESCALE || "patcher_timescale.js",
};
const LEGACY_PATCHER = process.env.PATCHER_NAME;

function resolvePatcher(mode) {
  const name     = PATCHER_MAP[mode] || PATCHER_MAP["bypass"];
  const resolved = path.join(__dirname, name);
  if (!fs.existsSync(resolved) && LEGACY_PATCHER) {
    const legacy = path.join(__dirname, LEGACY_PATCHER);
    if (fs.existsSync(legacy)) return legacy;
  }
  return resolved;
}

// ── /tmp janitor ───────────────────────────────────────────────────
const TMP_DIR        = "/tmp";
const TMP_MAX_AGE_MS = 30 * 60 * 1000;
const TMP_SCAN_MS    = 10 * 60 * 1000;

function runTmpJanitor() {
  try {
    const now   = Date.now();
    const files = fs.readdirSync(TMP_DIR);
    let   wiped = 0;
    for (const f of files) {
      if (!/^([0-9a-f]{16,}|patched_[0-9a-f]+\.mp4)$/i.test(f)) continue;
      const full = path.join(TMP_DIR, f);
      try {
        const { mtimeMs } = fs.statSync(full);
        if (now - mtimeMs > TMP_MAX_AGE_MS) { fs.unlinkSync(full); wiped++; }
      } catch (_) {}
    }
    if (wiped > 0) console.log(`[janitor] Cleaned ${wiped} stale file(s) from /tmp`);
  } catch (err) {
    console.warn("[janitor] Scan error:", err.message);
  }
}

runTmpJanitor();
setInterval(runTmpJanitor, TMP_SCAN_MS);

// ── Express setup ──────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

const upload = multer({
  dest:   TMP_DIR,
  limits: { fileSize: PREMIUM_LIMIT_BYTES + (5 * 1024 * 1024) },
});

// ── Safe delete ────────────────────────────────────────────────────
function safeDelete(filePath) {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

// ── Routes ─────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "JV Lightweight Server" });
});

app.get("/tier/:uid", (req, res) => {
  const { tier, limitMB } = getTier(req.params.uid);
  res.json({ tier, limit_mb: limitMB });
});

// Check upload quota without uploading
app.get("/quota/:uid", async (req, res) => {
  const uid           = req.params.uid;
  const { tier }      = getTier(uid);
  const info          = await getUploadInfo(uid, tier);
  res.json({ ...info, tier });
});

app.post("/patch", upload.single("video"), async (req, res) => {
  const file = req.file || (req.files && req.files.file && req.files.file[0]);
  if (!file) return res.status(400).json({ error: "No video file provided" });

  const uid        = req.body && req.body.uid;
  const { tier, limitBytes, limitMB } = getTier(uid);
  const inputPath  = file.path;
  let   outputPath = null;

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    safeDelete(inputPath);
    if (outputPath) safeDelete(outputPath);
  }
  res.on("close", cleanup);

  // ── Check file size ────────────────────────────────────────────
  if (file.size > limitBytes) {
    cleanup();
    return res.status(413).json({
      error:    `File exceeds the ${limitMB} MB limit for ${tier} users`,
      tier,
      limit_mb: limitMB,
      file_mb:  +(file.size / (1024 * 1024)).toFixed(1),
    });
  }

  // ── Check weekly upload quota ──────────────────────────────────
  if (uid) {
    const quota = await getUploadInfo(uid, tier);
    if (!quota.allowed) {
      cleanup();
      return res.status(429).json({
        error:      `Weekly limit reached (${quota.limit} uploads/week)`,
        tier,
        used:       quota.used,
        limit:      quota.limit,
        remaining:  0,
        resets_at:  quota.resets_at,   // ms timestamp
      });
    }
  }

  // ── Resolve patcher ────────────────────────────────────────────
  const patcherMode = (req.body && req.body.patcher_mode) || "bypass";
  const scriptPath  = resolvePatcher(patcherMode);

  if (!fs.existsSync(scriptPath)) {
    cleanup();
    return res.status(500).json({
      error: `Patcher for mode '${patcherMode}' not found. Expected: ${path.basename(scriptPath)}`,
    });
  }

  const fileId = crypto.randomBytes(16).toString("hex");
  outputPath   = path.join(TMP_DIR, `patched_${fileId}.mp4`);

  console.log(`[patch] UID=${uid || "Guest"} | tier=${tier} | mode=${patcherMode}`);

  execFile(
    "node",
    [scriptPath, inputPath, outputPath],
    { timeout: 300_000 },
    async (error, stdout, stderr) => {

      safeDelete(inputPath);

      if (error) {
        cleanup();
        return res.status(422).json({
          error:    `Patch failed: ${stderr || error.message}`,
          tier,
          limit_mb: limitMB,
        });
      }

      // ── Record the upload AFTER successful patch ───────────────
      if (uid) {
        try { await recordUpload(uid); } catch (e) {
          console.warn("[quota] Failed to record upload:", e.message);
        }
      }

      // ── Stream patched video directly back ─────────────────────
      res.setHeader("Content-Type",        "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="jv_${fileId}.mp4"`);
      res.setHeader("X-File-Id",           fileId);
      res.setHeader("X-Tier",              tier);
      res.setHeader("X-Limit-MB",          String(limitMB));

      // Send remaining quota in headers so extension can show it
      if (uid) {
        try {
          const q = await getUploadInfo(uid, tier);
          res.setHeader("X-Uploads-Used",      String(q.used));
          res.setHeader("X-Uploads-Limit",     String(q.limit));
          res.setHeader("X-Uploads-Remaining", String(q.remaining));
          res.setHeader("X-Uploads-Resets-At", String(q.resets_at || ''));
        } catch (_) {}
      }

      const stream = fs.createReadStream(outputPath);
      stream.on("error", (e) => {
        console.error("[patch] Stream error:", e.message);
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: "Failed to stream output file" });
      });
      stream.on("end", () => {
        cleanup();
        console.log(`[patch] Done — jv_${fileId}.mp4`);
      });
      stream.pipe(res);
    }
  );
});

// ── Error handler ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large (max ${(PREMIUM_LIMIT_BYTES / 1024 / 1024).toFixed(0)} MB)` });
  }
  if (err) return res.status(500).json({ error: err.message || "Unexpected error" });
  next();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] Listening on port ${PORT}`);
});
EOF
echo "Done"
