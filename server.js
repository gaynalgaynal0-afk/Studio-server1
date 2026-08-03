const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const PREMIUM_UIDS = require("./premium-check.js");

const FREE_LIMIT_BYTES    = 70  * 1024 * 1024;
const PREMIUM_LIMIT_BYTES = 120 * 1024 * 1024;

function getTier(uid) {
  const isPremium = !!uid && PREMIUM_UIDS.includes(String(uid));
  return {
    tier: isPremium ? "premium" : "free",
    limitBytes: isPremium ? PREMIUM_LIMIT_BYTES : FREE_LIMIT_BYTES,
    limitMB: isPremium ? 120 : 70,
  };
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

// Configure Multer for temporary upload storage. The hard ceiling here is
// just the multer-layer safety net (highest possible tier limit) — actual
// per-user enforcement happens after the file lands, based on their tier.
const upload = multer({
  dest: "/tmp/",
  limits: { fileSize: PREMIUM_LIMIT_BYTES + (5 * 1024 * 1024) }, // small buffer
});

// Configure S3 Client for Cloudflare R2
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : "https://986d0eb1bb514e03f6056730c987cb5e.r2.cloudflarestorage.com",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "af58a7c90330ad646caa39b955ffb229",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "246ba1ee7dbab9059ba723dcbd126c766426a2d1e5e47e182b35f51a076b1683",
  },
  // Without this, the SDK generates virtual-hosted-style URLs
  // (bucket.account.r2.cloudflarestorage.com) but signs the request as if
  // it were path-style — R2 then rejects the mismatched signature with a
  // 403. Path-style (account.r2.cloudflarestorage.com/bucket/key) is what
  // R2 actually expects.
  forcePathStyle: true,
});

// Helper: Upload file to Cloudflare R2 and return a 1-hour presigned URL
async function uploadToR2AndGetSignedUrl(filePath, destinationKey) {
  const fileStream = fs.createReadStream(filePath);
  const bucketName = process.env.R2_BUCKET_NAME || "jv-60fps-studio-server-bucket";

  // Upload object to R2
  const putCmd = new PutObjectCommand({
    Bucket: bucketName,
    Key: destinationKey,
    Body: fileStream,
    ContentType: "video/mp4",
  });
  await s3.send(putCmd);

  // Generate 1-hour temporary presigned GET URL
  const getCmd = new GetObjectCommand({
    Bucket: bucketName,
    Key: destinationKey,
  });

  const signedUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });
  return signedUrl;
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "JV Lightweight Server" });
});

app.post("/patch", upload.single("video"), async (req, res) => {
  const file = req.file || (req.files && req.files.file && req.files.file[0]);
  if (!file) {
    return res.status(400).json({ error: "No video file provided" });
  }

  const uid = req.body && req.body.uid;
  const { tier, limitBytes, limitMB } = getTier(uid);

  const inputPath = file.path;

  // Enforce the tier's actual limit here — multer's own limit above is
  // just a ceiling to allow premium-sized files through at all.
  if (file.size > limitBytes) {
    if (fs.existsSync(inputPath)) fs.unlink(inputPath, () => {});
    return res.status(413).json({
      error: `File exceeds the ${limitMB}MB limit for ${tier} users`,
      tier,
      limit_mb: limitMB,
      file_mb: +(file.size / (1024 * 1024)).toFixed(1),
    });
  }

  const fileId = crypto.randomBytes(16).toString("hex");
  const outputPath = path.join("/tmp", `patched_${fileId}.mp4`);
  const r2ObjectKey = `outputs/jv_${fileId}.mp4`;

  const cleanup = () => {
    [inputPath, outputPath].forEach((p) => {
      if (fs.existsSync(p)) fs.unlink(p, () => {});
    });
  };

  const scriptPath = path.join(__dirname, "patcher.py");

  // Run python patcher script
  execFile(
    "python3",
    [scriptPath, inputPath, outputPath],
    { timeout: 300000 },
    async (error, stdout, stderr) => {
      if (error) {
        cleanup();
        return res.status(422).json({ error: `Patch failed: ${stderr || error.message}`, tier, limit_mb: limitMB });
      }

      try {
        console.log("Uploading output to R2 and generating presigned link...");
        const signedUrl = await uploadToR2AndGetSignedUrl(outputPath, r2ObjectKey);
        cleanup();

        return res.json({
          status: "success",
          file_id: fileId,
          download_url: signedUrl,
          tier,
          limit_mb: limitMB,
        });
      } catch (uploadErr) {
        cleanup();
        return res.status(500).json({ error: `R2 Upload failed: ${uploadErr.message}`, tier, limit_mb: limitMB });
      }
    }
  );
});

// Catches multer's own errors (e.g. file bigger than the outer safety-net
// limit) so they come back as JSON instead of a raw crash/HTML error.
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File exceeds the maximum allowed size (${(PREMIUM_LIMIT_BYTES / (1024*1024)).toFixed(0)}MB)` });
  }
  if (err) {
    return res.status(500).json({ error: err.message || "Unexpected server error" });
  }
  next();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
