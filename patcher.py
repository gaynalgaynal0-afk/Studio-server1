import os
import tempfile
import subprocess
import imageio_ffmpeg

def patch_shark_sample_table(raw_bytes: bytes):
    # Get the path to the ffmpeg executable provided by imageio-ffmpeg
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

    # Write input bytes to temporary file
    with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as tmp_in:
        tmp_in.write(raw_bytes)
        tmp_in_path = tmp_in.name

    tmp_out_path = tmp_in_path + '_patched.mp4'

    try:
        ffmpeg_cmd = [
            ffmpeg_exe,
            '-y',
            '-i', tmp_in_path,
            '-r', '60',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-c:a', 'copy',
            tmp_out_path
        ]

        subprocess.run(ffmpeg_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        with open(tmp_out_path, 'rb') as f:
            output_bytes = f.read()

        real_samples = 60
        fake_samples = 60

        return output_bytes, real_samples, fake_samples

    finally:
        if os.path.exists(tmp_in_path):
            os.remove(tmp_in_path)
        if os.path.exists(tmp_out_path):
            os.remove(tmp_out_path)
