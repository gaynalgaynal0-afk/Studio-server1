// ── Upstash Redis REST helper ──────────────────────────────────────
// Tracks upload counts per UID in a 7-day rolling window.
// No npm packages needed — plain HTTPS fetch.

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://assuring-ray-176654.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAArIOAAIgcDEzM2VjMmU2Mjk2NGY0MjEyODY5NjJiOWYwMDgzNWMxNQ';

const WEEK_MS      = 7 * 24 * 60 * 60 * 1000;  // 7 days in ms
const FREE_LIMIT   = 3;
const PREMIUM_LIMIT = 999; // unlimited for premium

// Low-level Upstash REST call
async function redis(...args) {
  const r = await fetch(`${UPSTASH_URL}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const d = await r.json();
  if (d.error) throw new Error(`Redis error: ${d.error}`);
  return d.result;
}

// Key per UID — stores a JSON array of upload timestamps
function key(uid) { return `uploads:${uid}`; }

// Check how many uploads this UID has done in the last 7 days
async function getUploadInfo(uid, tier) {
  const limit = (tier === 'premium') ? PREMIUM_LIMIT : FREE_LIMIT;
  const now   = Date.now();

  let timestamps = [];
  try {
    const raw = await redis('GET', key(uid));
    if (raw) timestamps = JSON.parse(raw);
  } catch (_) {}

  // Only keep timestamps within the last 7 days
  const recent = timestamps.filter(t => now - t < WEEK_MS);

  // When does the oldest upload expire (i.e. when does a slot free up)?
  const oldestTs  = recent.length >= limit ? Math.min(...recent) : null;
  const resetsAt  = oldestTs ? oldestTs + WEEK_MS : null;
  const remaining = Math.max(0, limit - recent.length);

  return {
    allowed:   recent.length < limit,
    used:      recent.length,
    limit,
    remaining,
    resets_at: resetsAt,   // ms timestamp when next slot opens
  };
}

// Record a successful upload for this UID
async function recordUpload(uid) {
  const now = Date.now();
  let timestamps = [];
  try {
    const raw = await redis('GET', key(uid));
    if (raw) timestamps = JSON.parse(raw);
  } catch (_) {}

  // Only keep last 7 days + add new one
  const recent = timestamps.filter(t => now - t < WEEK_MS);
  recent.push(now);

  // Store with 8-day TTL so Redis auto-cleans old keys
  await redis('SET', key(uid), JSON.stringify(recent), 'EX', String(8 * 24 * 60 * 60));
}

module.exports = { getUploadInfo, recordUpload };
EOF
echo "Done"
