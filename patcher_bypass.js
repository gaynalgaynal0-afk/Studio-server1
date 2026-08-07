/**
 * patcher_bypass.js  —  JV Server  (Old + FPS Patch mode)
 *
 * Flow:
 *   1. Receive video path from JV server  (argv[2] = input, argv[3] = output)
 *   2. Upload to Kuronai cloud API        (POST /upload/)
 *   3. Poll / wait for Kuronai to process the video
 *   4. Download the processed video       (GET /download/{file_id})
 *   5. Write it to the output path        (JV server then uploads to R2)
 *   6. Cleanup on Kuronai                 (DELETE /cleanup/{file_id})
 *
 * Hard-coded Telegram ID: 7082829394
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
const https   = require("https");
const http    = require("http");
const { URL } = require("url");

// ── Config ────────────────────────────────────────────────────────────────
const KURONAI_TG_ID   = "7082829394";           // Hard-coded Telegram ID
const KURONAI_BASE    = "https://api.kuronaiapp.com";
const UPLOAD_URL      = `${KURONAI_BASE}/upload/`;
const DOWNLOAD_URL    = (fileId) => `${KURONAI_BASE}/download/${fileId}`;
const CLEANUP_URL     = (fileId) => `${KURONAI_BASE}/cleanup/${fileId}`;

const UPLOAD_TIMEOUT_MS   = 5 * 60 * 1000;   // 5 min upload
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min download

// ── CLI args ──────────────────────────────────────────────────────────────
const inputPath  = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error("Usage: node patcher_bypass.js <inputPath> <outputPath>");
  process.exit(1);
}

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a multipart/form-data body manually — avoids any npm dependency.
 * Returns { body: Buffer, boundary: string }
 */
function buildFormData(filePath, tgId) {
  const boundary = `----JVBoundary${Date.now().toString(16)}`;
  const filename  = path.basename(filePath);
  const fileData  = fs.readFileSync(filePath);

  const parts = [];

  // Part 1: tg_id text field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="tg_id"\r\n\r\n` +
      `${tgId}\r\n`
    )
  );

  // Part 2: video file
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: video/mp4\r\n\r\n`
    )
  );
  parts.push(fileData);
  parts.push(Buffer.from("\r\n"));

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body:     Buffer.concat(parts),
    boundary: boundary,
  };
}

/**
 * Make an HTTP/HTTPS request.
 * Returns a Promise that resolves to { statusCode, headers, body: Buffer }
 */
function request(urlStr, options = {}, bodyBuffer = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(urlStr);
    const lib     = parsed.protocol === "https:" ? https : http;
    const timeout = options.timeout || 60000;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   options.method || "GET",
        headers:  options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            headers:    res.headers,
            body:       Buffer.concat(chunks),
          })
        );
      }
    );

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeout}ms: ${urlStr}`));
    });

    req.on("error", reject);

    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

/** Sleep for ms milliseconds */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────

async function run() {
  // ── Step 1: Upload to Kuronai ─────────────────────────────────────────
  console.log(`[patcher_bypass] Uploading to Kuronai... (tg_id: ${KURONAI_TG_ID})`);
  console.log(`[patcher_bypass] Input: ${inputPath} (${(fs.statSync(inputPath).size / 1024 / 1024).toFixed(2)} MB)`);

  const { body: formBody, boundary } = buildFormData(inputPath, KURONAI_TG_ID);

  let uploadRes;
  try {
    uploadRes = await request(
      UPLOAD_URL,
      {
        method:  "POST",
        timeout: UPLOAD_TIMEOUT_MS,
        headers: {
          "Content-Type":   `multipart/form-data; boundary=${boundary}`,
          "Content-Length": formBody.length,
        },
      },
      formBody
    );
  } catch (err) {
    throw new Error(`Upload network error: ${err.message}`);
  }

  if (uploadRes.statusCode < 200 || uploadRes.statusCode >= 300) {
    throw new Error(
      `Kuronai upload failed — HTTP ${uploadRes.statusCode}: ${uploadRes.body.toString().slice(0, 300)}`
    );
  }

  let uploadData;
  try {
    uploadData = JSON.parse(uploadRes.body.toString());
  } catch {
    throw new Error(`Kuronai upload returned non-JSON: ${uploadRes.body.toString().slice(0, 200)}`);
  }

  const fileId = uploadData.file_id;
  if (!fileId) {
    throw new Error(`Kuronai upload response missing file_id: ${JSON.stringify(uploadData)}`);
  }

  console.log(`[patcher_bypass] Upload complete. file_id: ${fileId}`);

  // ── Step 2: Wait for Kuronai to process ──────────────────────────────
  // Kuronai processes server-side after upload. The extension gives it 
  // time before downloading — we do the same by polling the download 
  // endpoint with a short initial wait then retries.
  console.log("[patcher_bypass] Waiting for Kuronai processing...");
  await sleep(4000);  // Initial processing wait

  // ── Step 3: Download processed video from Kuronai ────────────────────
  const dlUrl = DOWNLOAD_URL(fileId);
  console.log(`[patcher_bypass] Downloading processed video from Kuronai...`);

  let dlRes;
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      dlRes = await request(
        dlUrl,
        {
          method:  "GET",
          timeout: DOWNLOAD_TIMEOUT_MS,
        }
      );

      if (dlRes.statusCode === 200) break;

      // 202 or 404 likely means still processing
      if (dlRes.statusCode === 202 || dlRes.statusCode === 404) {
        console.log(`[patcher_bypass] Not ready yet (HTTP ${dlRes.statusCode}), retry ${attempts}/${maxAttempts} in 5s...`);
        await sleep(5000);
        continue;
      }

      // Any other non-200 is a hard error
      throw new Error(
        `Kuronai download failed — HTTP ${dlRes.statusCode}: ${dlRes.body.toString().slice(0, 300)}`
      );

    } catch (err) {
      if (attempts >= maxAttempts) throw err;
      console.log(`[patcher_bypass] Download error, retry ${attempts}/${maxAttempts}: ${err.message}`);
      await sleep(5000);
    }
  }

  if (!dlRes || dlRes.statusCode !== 200) {
    throw new Error(`Kuronai download failed after ${maxAttempts} attempts`);
  }

  const videoBuffer = dlRes.body;
  if (!videoBuffer || videoBuffer.length < 1024) {
    throw new Error(`Kuronai returned an unexpectedly small file (${videoBuffer ? videoBuffer.length : 0} bytes)`);
  }

  console.log(`[patcher_bypass] Downloaded ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB from Kuronai.`);

  // ── Step 4: Write to output path (JV server picks this up) ───────────
  fs.writeFileSync(outputPath, videoBuffer);
  console.log(`[patcher_bypass] Written to output: ${outputPath}`);

  // ── Step 5: Cleanup on Kuronai (fire-and-forget) ─────────────────────
  request(CLEANUP_URL(fileId), { method: "DELETE", timeout: 15000 })
    .then(() => console.log(`[patcher_bypass] Kuronai cleanup complete for file_id: ${fileId}`))
    .catch((err) => console.warn(`[patcher_bypass] Cleanup warning (non-fatal): ${err.message}`));
}

run().then(() => {
  console.log("[patcher_bypass] Done.");
  process.exit(0);
}).catch((err) => {
  console.error(`[patcher_bypass] Fatal error: ${err.message}`);
  process.exit(1);
});
