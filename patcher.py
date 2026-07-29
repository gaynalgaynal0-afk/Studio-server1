"""
FFmpeg MP4 Patcher
Processes MP4 video data using FFmpeg with custom filters and faststart.
"""

import os
import tempfile
import subprocess

def patch_video_ffmpeg(raw_bytes: bytes) -> bytes:
    """
    Applies 60FPS, scaling, sharpening, and faststart remuxing using FFmpeg.
    
    Returns:
        bytes: The processed MP4 video data.
    """
    in_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    out_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    in_path = in_tmp.name
    out_path = out_tmp.name

    try:
        # Write input bytes to temp file
        in_tmp.write(raw_bytes)
        in_tmp.flush()
        in_tmp.close()
        out_tmp.close()

        # Build FFmpeg command
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", in_path,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
            "-profile:v", "high", "-level", "4.2",
            "-b:v", "12M", "-maxrate", "14M", "-bufsize", "18M",
            "-vf", "scale=1080:-2,fps=60,format=yuv420p,unsharp=5:5:0.8:3:3:0.4",
            "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
            "-movflags", "+faststart",
            out_path
        ]

        # Execute FFmpeg process
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg encoding failed: {result.stderr.strip()}")

        # Read output back into memory
        with open(out_path, 'rb') as f:
            output_bytes = f.read()

        return output_bytes

    finally:
        # Always clean up temporary files
        for path in (in_path, out_path):
            if os.path.exists(path):
                try:
                    os.remove(path)
                except Exception:
                    pass
