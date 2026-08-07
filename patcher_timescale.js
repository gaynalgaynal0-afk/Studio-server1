const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function getFps(filePath) {
  try {
    const stdout = execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate",
      "-of", "json",
      filePath
    ], { encoding: "utf8", timeout: 30000 });

    const data = JSON.parse(stdout);
    const rate = data.streams[0].r_frame_rate; // e.g., "30/1" or "60000/1001"
    const [num, den] = rate.split("/").map(Number);
    
    if (!num || !den) return null;
    return Number((num / den).toFixed(4));
  } catch (err) {
    console.error("[FPS Detect Error]:", err.message);
    return null;
  }
}

function patchTo60Fps(inputPath, outputPath, originalFps) {
  const targetFps = 60;
  const itsscale = (originalFps / targetFps).toFixed(4);

  try {
    execFileSync("ffmpeg", [
      "-y",
      "-itsscale", itsscale,
      "-i", inputPath,
      "-c", "copy",
      outputPath
    ], { encoding: "utf8", timeout: 600000 });

    return true;
  } catch (err) {
    console.error("[FFmpeg Error]:", err.message);
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: node patcher.js <input.mp4> <output.mp4>");
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = path.resolve(args[1]);

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: File not found -> ${inputPath}`);
    process.exit(1);
  }

  // Step 1: Detect FPS
  const fps = getFps(inputPath);
  if (!fps || fps <= 0) {
    console.error("Error: Could not detect FPS — ensure it is a valid MP4 video.");
    process.exit(422);
  }

  console.log(`Detected original FPS: ${fps}`);

  // Step 2: If already ~60fps, copy file directly
  if (Math.abs(fps - 60) < 0.5) {
    console.log("Video is already ~60 FPS. Copying stream directly...");
    fs.copyFileSync(inputPath, outputPath);
    console.log(`Patched successfully -> ${outputPath}`);
    process.exit(0);
  }

  // Step 3: Patch using -itsscale
  const success = patchTo60Fps(inputPath, outputPath, fps);

  if (success) {
    console.log(`Patched successfully -> ${outputPath}`);
    process.exit(0);
  } else {
    console.error("FFmpeg patch failed.");
    process.exit(1);
  }
}

main();
