"""
JV-60FPS Server
Executes FFmpeg encoding followed by node patcher.js
"""

import os
import uuid
import tempfile
import subprocess
from flask import Flask, request, send_file, jsonify, after_this_request

app = Flask(__name__)
MAX_SIZE = 500 * 1024 * 1024  # 500 MB limit

@app.after_request
def cors(r):
    r.headers['Access-Control-Allow-Origin'] = '*'
    r.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    r.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return r

@app.route('/')
def index():
    return jsonify({"status": "ok", "service": "JV 60FPS Server (Node Patcher)"})

@app.route('/health')
def health():
    return jsonify({"status": "ok"})

@app.route('/patch', methods=['OPTIONS'])
def patch_options():
    return '', 204

@app.route('/patch', methods=['POST'])
def patch():
    f = request.files.get('video') or request.files.get('file')
    if not f:
        return jsonify({"error": "No video field provided"}), 400

    raw = f.read()
    if not raw:
        return jsonify({"error": "Empty file"}), 400
    if len(raw) > MAX_SIZE:
        return jsonify({"error": "File too large (max 500MB)"}), 413

    in_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    encoded_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    out_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)

    in_path = in_tmp.name
    encoded_path = encoded_tmp.name
    out_path = out_tmp.name

    try:
        in_tmp.write(raw)
        in_tmp.flush()
        in_tmp.close()
        encoded_tmp.close()
        out_tmp.close()

        # Step 1: Run FFmpeg Encoding
        ffmpeg_cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", in_path,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
            "-profile:v", "high", "-level", "4.2",
            "-b:v", "12M", "-maxrate", "14M", "-bufsize", "18M",
            "-vf", "scale=1080:-2,fps=60,format=yuv420p,unsharp=5:5:0.8:3:3:0.4",
            "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
            "-movflags", "+faststart",
            encoded_path
        ]

        ffmpeg_res = subprocess.run(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if ffmpeg_res.returncode != 0:
            raise RuntimeError(f"FFmpeg encoding failed: {ffmpeg_res.stderr.strip()}")

        # Step 2: Run patcher.js using Node
        script_path = os.path.join(os.path.dirname(__file__), "patcher.js")
        node_cmd = ["node", script_path, encoded_path, out_path]

        node_res = subprocess.run(node_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if node_res.returncode != 0:
            raise RuntimeError(f"Node patcher failed: {node_res.stderr.strip()}")

        file_id = uuid.uuid4().hex
        out_name = f'jv_{file_id}.mp4'

        @after_this_request
        def cleanup(response):
            for path in (in_path, encoded_path, out_path):
                try:
                    if os.path.exists(path):
                        os.remove(path)
                except Exception:
                    pass
            return response

        resp = send_file(out_path, mimetype='video/mp4', as_attachment=True, download_name=out_name)
        resp.headers['X-File-Id'] = file_id
        return resp

    except Exception as e:
        for path in (in_path, encoded_path, out_path):
            if os.path.exists(path):
                try:
                    os.remove(path)
                except Exception:
                    pass
        return jsonify({"error": str(e)}), 422

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
