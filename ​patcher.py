import os
import tempfile
import subprocess

def patch_shark_sample_table(raw_bytes: bytes):
    """
    Processes video data using FFmpeg to adjust frame rates / sample attributes.
    
    Args:
        raw_bytes (bytes): Raw video file content uploaded to the server.
        
    Returns:
        tuple: (output_bytes, real_samples, fake_samples)
    """
    # Write incoming raw bytes to a temporary input file
    with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as tmp_in:
        tmp_in.write(raw_bytes)
        tmp_in_path = tmp_in.name

    tmp_out_path = tmp_in_path + '_patched.mp4'

    try:
        # Build FFmpeg command to adjust frame rate to 60 FPS with high quality output
        ffmpeg_cmd = [
            'ffmpeg',
            '-y',                      # Overwrite output file if exists
            '-i', tmp_in_path,          # Input video file
            '-r', '60',                 # Target output frame rate (60 FPS)
            '-c:v', 'libx264',          # Re-encode video using H.264
            '-preset', 'fast',          # Encoding speed preset
            '-crf', '18',               # Quality factor (lower = higher quality)
            '-c:a', 'copy',             # Copy audio track without re-encoding
            tmp_out_path
        ]

        # Execute FFmpeg command
        subprocess.run(ffmpeg_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # Read patched output back into bytes
        with open(tmp_out_path, 'rb') as f:
            output_bytes = f.read()

        # Placeholders for sample metrics (customize according to your frame count analysis)
        real_samples = 60
        fake_samples = 60

        return output_bytes, real_samples, fake_samples

    finally:
        # Clean up temporary files from disk
        if os.path.exists(tmp_in_path):
            os.remove(tmp_in_path)
        if os.path.exists(tmp_out_path):
            os.remove(tmp_out_path)
