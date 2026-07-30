const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for all clients
app.use(cors());

// Configure temporary disk storage for uploads
const upload = multer({
  dest: path.join(__dirname, "temp_uploads/"),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB limit
});

// Create upload directory if it doesn't exist
const tempDir = path.join(__dirname, "temp_uploads");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "JV Node.js Concurrent Server" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Support upload fields "video" or "file"
const uploadFields = upload.fields([
  { name: "video", maxCount: 1 },
  { name: "file", maxCount: 1 },
]);

app.post("/patch", uploadFields, (req, res) => {
  const uploadedFile =
    (req.files && req.files.video && req.files.video[0]) ||
    (req.files && req.files.file && req.files.file[0]);

  if (!uploadedFile) {
    return res.status(400).json({ error: "No video file provided" });
  }

  const inputPath = uploadedFile.path;
  const fileId = crypto.randomBytes(16).toString("hex");
  const outputPath = path.join(tempDir, `out_${fileId}.mp4`);
  const downloadName = `jv_${fileId}.mp4`;

  const scriptPath = path.join(__dirname, "patcher.py");

  // Execute patcher.py asynchronously without blocking the event loop
  execFile(
    "python3",
    [scriptPath, inputPath, outputPath],
    { timeout: 300000 }, // 5-minute timeout per video process
    (error, stdout, stderr) => {
      // Helper function to clean up temporary files
      const cleanup = () => {
        if (fs.existsSync(inputPath)) fs.unlink(inputPath, () => {});
        if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
      };

      if (error) {
        cleanup();
        const errDetails = stderr.trim() || stdout.trim() || error.message;
        return res
          .status(422)
          .json({ error: `Processing failed: ${errDetails}` });
      }

      res.setHeader("X-File-Id", fileId);
      res.download(outputPath, downloadName, (err) => {
        cleanup();
      });
    }
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Node server running on port ${PORT}`);
});
