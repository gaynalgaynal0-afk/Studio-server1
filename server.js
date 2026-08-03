const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { execFile, exec } = require("child_process");
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

// Configure Multer for temporary upload storage
const upload = multer({
  dest: "/tmp/",
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB limit
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
});

// Helper: Upload file to Cloudflare R2
async function uploadToR2(filePath, destinationKey) {
  const fileStream = fs.createReadStream(filePath);
  const bucketName = process.env.R2_BUCKET_NAME || "jv-60fps-studio-server-bucket";

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: destinationKey,
    Body: fileStream,
    ContentType: "video/mp4",
  });

  await s3.send(command);

  const publicBase = process.env.R2_PUBLIC_DOMAIN || `https://986d0eb1bb514e03f6056730c987cb5e.r2.cloudflarestorage.com/${bucketName}`;
  return `${publicBase}/${destinationKey}`;
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "JV 60FPS R2 & 1080p Server" });
});

app.post("/patch", upload.single("video"), async (req, res) => {
  const file = req.file || (req.files && req.files.file && req.files.file[0]);
  if (!file) {
    return res.status(400).json({ error: "No video file provided" });
  }

  const inputPath = file.path;
  const fileId = crypto.randomBytes(16).toString("hex");
  const patchedPath = path.join("/tmp", `patched_${fileId}.mp4`);
  const finalPath = path.join("/tmp", `out_1080p60_${fileId}.mp4`);
  const r2ObjectKey = `outputs/jv_${fileId}.mp4`;

  // Function to delete temp files safely
  const cleanup = () => {
    [inputPath, patchedPath, finalPath].forEach((p) => {
      if (fs.existsSync(p)) fs.unlink(p, () => {});
    });
  };

  const scriptPath = path.join(__dirname, "patcher.py");

  // Step 1: Run Python Patcher
  execFile(
    "python3",
    [scriptPath, inputPath, patchedPath],
    { timeout: 300000 },
    (error, stdout, stderr) => {
      if (error) {
        cleanup();
        return res.status(422).json({ error: `Patch failed: ${stderr || error.message}` });
      }

      // Step 2: Run FFmpeg Re-encode to 1080p 60FPS @ 20Mbps (Preserving Aspect Ratio)
      const ffmpegCmd = `ffmpeg -y -i "${patchedPath}" -vf "scale='if(gt(a,16/9),1920,-2)':'if(gt(a,16/9),-2,1080)',fps=60" -c:v libx264 -preset fast -b:v 20M -maxrate 22M -bufsize 40M -c:a copy -movflags +faststart "${finalPath}"`;

      exec(ffmpegCmd, { timeout: 600000 }, async (ffErr, ffStdout, ffStderr) => {
        if (ffErr) {
          cleanup();
          return res.status(500).json({ error: `FFmpeg re-encoding failed: ${ffStderr || ffErr.message}` });
        }

        try {
          // Step 3: Upload output to Cloudflare R2
          console.log("Uploading 1080p 60FPS video to Cloudflare R2...");
          const r2Url = await uploadToR2(finalPath, r2ObjectKey);
          
          cleanup();

          // Step 4: Return JSON response to client / extension
          return res.json({
            status: "success",
            file_id: fileId,
            download_url: r2Url,
          });
        } catch (uploadErr) {
          cleanup();
          return res.status(500).json({ error: `R2 Upload failed: ${uploadErr.message}` });
        }
      });
    }
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
