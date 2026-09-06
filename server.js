// ── JV Studio Server — Railway Edition ───────────────────────────────────────
// No ffmpeg — pure JS patcher only
// Routes:
//   GET  /               → health check
//   GET  /tier/:uid      → get tier info
//   GET  /quota/:uid     → get upload quota
//   GET  /maintenance    → public maintenance status (extension polls this)
//   GET  /admin          → admin toggle page (?key=ADMIN_KEY)
//   POST /admin/toggle   → flip maintenance flag (?key=ADMIN_KEY)
//   POST /verify         → check Telegram channel membership
//   POST /patch          → patch MP4 (multipart: video + uid)

const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const { getUploadInfo, recordUpload } = require('./upstash');
const { patchMp4 } = require('./patcher_bypass');

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHANNEL    = '@jv_60fps';
const PORT       = process.env.PORT || 5000;
const TMP_DIR    = '/tmp';

// ── Tier config ───────────────────────────────────────────────────────────────
const FREE_LIMIT_MB    = 70;
const PREMIUM_LIMIT_MB = 120;

function getPremiumUids() {
  try {
    return require('./premium-check.js').map(String);
  } catch { return []; }
}

function getTier(uid) {
  const isPremium = !!uid && getPremiumUids().includes(String(uid));
  return {
    tier:       isPremium ? 'premium' : 'free',
    limitBytes: (isPremium ? PREMIUM_LIMIT_MB : FREE_LIMIT_MB) * 1024 * 1024,
    limitMB:    isPremium ? PREMIUM_LIMIT_MB : FREE_LIMIT_MB,
  };
}

// ── Maintenance mode ───────────────────────────────────────────────────────────
// Persists via Upstash Redis REST (same store already used for quota tracking)
// when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set — this
// survives redeploys. Falls back to a local JSON file otherwise, which still
// works fine for manual toggling but resets if the container redeploys.
const ADMIN_KEY      = process.env.ADMIN_KEY || 'changeme';
const UPSTASH_URL    = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;
const MAINT_KEY       = 'jv:hq:maintenance';
const MAINT_FILE      = path.join(__dirname, 'maintenance.json');

async function getMaintenance() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const r = await fetch(`${UPSTASH_URL}/get/${MAINT_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      const d = await r.json();
      return d.result === '1';
    } catch (e) {
      console.warn('[maintenance] Upstash read failed, falling back to file:', e.message);
    }
  }
  try {
    const data = JSON.parse(fs.readFileSync(MAINT_FILE, 'utf8'));
    return !!data.enabled;
  } catch {
    return false;
  }
}

async function setMaintenance(enabled) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      await fetch(`${UPSTASH_URL}/set/${MAINT_KEY}/${enabled ? '1' : '0'}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      return;
    } catch (e) {
      console.warn('[maintenance] Upstash write failed, falling back to file:', e.message);
    }
  }
  try {
    fs.writeFileSync(MAINT_FILE, JSON.stringify({ enabled }));
  } catch (e) {
    console.error('[maintenance] Could not persist to file:', e.message);
  }
}

function renderAdminPage(enabled, key) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JV Admin — HQ Maintenance</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  body {
    background: #0a0a0a; color: #fff;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .card {
    background: linear-gradient(160deg, #141414, #0d0d0d);
    border: 1px solid #232323;
    border-radius: 20px;
    padding: 32px 30px;
    width: 100%; max-width: 380px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .brand { font-size: 12px; font-weight: 800; letter-spacing: 2px; color: #ff3333; text-transform: uppercase; margin-bottom: 4px; }
  h1 { font-size: 19px; font-weight: 700; margin-bottom: 22px; }
  .status-row {
    display: flex; align-items: center; justify-content: space-between;
    background: #131313; border: 1px solid #222; border-radius: 14px;
    padding: 16px 18px; margin-bottom: 18px;
  }
  .status-label { font-size: 13px; font-weight: 600; color: #ccc; }
  .status-badge {
    font-size: 11px; font-weight: 800; letter-spacing: 0.5px;
    padding: 5px 12px; border-radius: 20px;
  }
  .status-badge.on  { background: rgba(255,59,59,0.12); color: #ff5555; border: 1px solid rgba(255,59,59,0.35); }
  .status-badge.off { background: rgba(34,232,143,0.10); color: #22e88f; border: 1px solid rgba(34,232,143,0.3); }
  .desc { font-size: 12px; color: #666; line-height: 1.5; margin-bottom: 22px; }
  button {
    width: 100%; padding: 14px; border: none; border-radius: 12px;
    font-size: 14px; font-weight: 700; cursor: pointer;
    transition: opacity 0.2s;
  }
  button:hover { opacity: 0.88; }
  .btn-enable  { background: linear-gradient(135deg, #ff3b3b, #cc1f1f); color: #fff; }
  .btn-disable { background: linear-gradient(135deg, #22e88f, #17b06d); color: #06251a; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">JV Studio Server</div>
    <h1>HQ Upload — Maintenance</h1>

    <div class="status-row">
      <span class="status-label">Current status</span>
      <span class="status-badge ${enabled ? 'on' : 'off'}">${enabled ? 'MAINTENANCE ON' : 'LIVE'}</span>
    </div>

    <p class="desc">
      ${enabled
        ? 'HQ Upload is locked in the extension right now. Every /patch request returns 503 and users see "Method is on maintenance". Old + FPS Patch is unaffected.'
        : 'HQ Upload is working normally. Turning maintenance on will immediately lock the HQ button for every user.'}
    </p>

    <form method="POST" action="/admin/toggle?key=${encodeURIComponent(key)}">
      <button type="submit" class="${enabled ? 'btn-disable' : 'btn-enable'}">
        ${enabled ? 'Turn OFF — restore HQ Upload' : 'Turn ON — lock HQ Upload'}
      </button>
    </form>
  </div>
</body>
</html>`;
}

// ── Telegram membership check ─────────────────────────────────────────────────
async function checkMembership(uid) {
  if (!BOT_TOKEN) return { ok: false, error: 'BOT_TOKEN not set' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(CHANNEL)}&user_id=${uid}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (!d.ok) return { ok: false, error: d.description };
    const status = d.result && d.result.status;
    return { ok: true, member: ['member','administrator','creator'].includes(status), status };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ── Cleanup /tmp ──────────────────────────────────────────────────────────────
function safeDelete(filePath) {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(TMP_DIR).forEach(f => {
      if (!/^jv_/.test(f)) return;
      const full = path.join(TMP_DIR, f);
      try {
        if (now - fs.statSync(full).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(full);
      } catch {}
    });
  } catch {}
}, 10 * 60 * 1000);

// ── Express setup ─────────────────────────────────────────────────────────────
const app    = express();
const upload = multer({ dest: TMP_DIR, limits: { fileSize: PREMIUM_LIMIT_MB * 1024 * 1024 + 5 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'JV Studio Server', version: '2.0' });
});

app.get('/tier/:uid', (req, res) => {
  const { tier, limitMB } = getTier(req.params.uid);
  res.json({ tier, limit_mb: limitMB });
});

app.get('/quota/:uid', async (req, res) => {
  const uid      = req.params.uid;
  const { tier } = getTier(uid);
  const info     = await getUploadInfo(uid, tier);
  res.json({ ...info, tier });
});

// ── Maintenance status — public, polled by the extension ─────────────────────
app.get('/maintenance', async (req, res) => {
  const enabled = await getMaintenance();
  res.json({ enabled });
});

// ── Admin toggle page — protected by ADMIN_KEY ────────────────────────────────
app.get('/admin', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).send('Forbidden');
  const enabled = await getMaintenance();
  res.send(renderAdminPage(enabled, req.query.key));
});

app.post('/admin/toggle', async (req, res) => {
  const key = req.query.key;
  if (key !== ADMIN_KEY) return res.status(403).send('Forbidden');
  const current = await getMaintenance();
  await setMaintenance(!current);
  console.log(`[maintenance] HQ maintenance turned ${!current ? 'ON' : 'OFF'}`);
  res.redirect(`/admin?key=${encodeURIComponent(key)}`);
});

app.post('/verify', async (req, res) => {
  const uid = String(req.body && req.body.uid || '').trim();
  if (!uid || !/^\d{5,15}$/.test(uid)) return res.status(400).json({ error: 'Invalid UID' });

  const result = await checkMembership(uid);
  if (!result.ok) return res.status(500).json({ error: result.error });

  const { tier } = getTier(uid);
  res.json({ member: result.member, status: result.status, tier });
});

// ── /patch — gated behind maintenance check BEFORE multer touches the body ──
// Checking here (as its own middleware, ahead of upload.single) means a
// maintenance-locked request never gets its multipart body parsed or written
// to /tmp at all — it's rejected instantly with zero wasted bandwidth/disk.
app.post('/patch', async (req, res, next) => {
  const maintenance = await getMaintenance();
  if (maintenance) {
    return res.status(503).json({
      error: 'HQ Upload is currently under maintenance. Please switch to Old + FPS Patch or try again later.',
      maintenance: true,
    });
  }
  next();
}, upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No video file provided' });

  const uid                        = String(req.body && req.body.uid || '').trim();
  const { tier, limitBytes, limitMB } = getTier(uid);
  const inputPath                  = file.path;
  let   outputPath                 = null;
  let   cleaned                    = false;

  function cleanup() {
    if (cleaned) return; cleaned = true;
    safeDelete(inputPath);
    if (outputPath) safeDelete(outputPath);
  }
  res.on('close', cleanup);

  // Size check
  if (file.size > limitBytes) {
    cleanup();
    return res.status(413).json({
      error:    `File exceeds ${limitMB}MB limit for ${tier} users`,
      tier, limit_mb: limitMB,
      file_mb:  +(file.size / 1024 / 1024).toFixed(1),
    });
  }

  // Quota check
  if (uid) {
    const quota = await getUploadInfo(uid, tier);
    if (!quota.allowed) {
      cleanup();
      return res.status(429).json({
        error:     `Weekly limit reached (${quota.limit} uploads/week)`,
        tier, used: quota.used, limit: quota.limit, remaining: 0,
        resets_at: quota.resets_at,
      });
    }
  }

  // Patch
  try {
    const inputBuf = fs.readFileSync(inputPath).buffer;
    const patched  = patchMp4(inputBuf);

    const fileId = crypto.randomBytes(8).toString('hex');
    outputPath   = path.join(TMP_DIR, `jv_${fileId}.mp4`);
    fs.writeFileSync(outputPath, patched);

    safeDelete(inputPath);

    // Record upload
    if (uid) {
      try { await recordUpload(uid); } catch(e) { console.warn('quota record failed:', e.message); }
    }

    // Build response headers
    const headers = {
      'Content-Type':        'video/mp4',
      'Content-Disposition': `attachment; filename="jv_${fileId}.mp4"`,
      'X-Tier':              tier,
      'X-Limit-MB':          String(limitMB),
    };

    if (uid) {
      try {
        const q = await getUploadInfo(uid, tier);
        headers['X-Uploads-Used']      = String(q.used);
        headers['X-Uploads-Limit']     = String(q.limit);
        headers['X-Uploads-Remaining'] = String(q.remaining);
        if (q.resets_at) headers['X-Uploads-Resets-At'] = String(q.resets_at);
      } catch {}
    }

    // Content-Length so the client gets real download percentage
    try {
      const stats = fs.statSync(outputPath);
      headers['Content-Length'] = String(stats.size);
      console.log(`[server] Sending ${fileId}.mp4 (${(stats.size / 1024 / 1024).toFixed(2)}MB) with Content-Length header`);
    } catch (err) {
      console.warn('[server] Could not get file size:', err.message);
    }

    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

    const stream = fs.createReadStream(outputPath);
    stream.on('end', cleanup);
    stream.on('error', (e) => { console.error('Stream error:', e.message); cleanup(); });
    stream.pipe(res);

  } catch(err) {
    cleanup();
    return res.status(422).json({ error: `Patch failed: ${err.message}` });
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: `File too large (max ${PREMIUM_LIMIT_MB}MB)` });
  if (err) return res.status(500).json({ error: err.message });
  next();
});

app.listen(PORT, '0.0.0.0', () => console.log(`[server] Listening on port ${PORT}`));
