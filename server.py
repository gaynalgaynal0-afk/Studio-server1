"""
JV Render Server (WASM Patcher Host)
Handles POST requests by invoking patcher.js with FFmpeg WASM
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
    return jsonify({"status": "ok", "service": "JV WASM Server Ready"})

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
        return jsonify({"error": "No video file provided in form-data"}), 400

    raw = f.read()
    if not raw:
        return jsonify({"error": "File is empty"}), 400
    if len(raw) > MAX_SIZE:
        return jsonify({"error": "File exceeds maximum size limit (500MB)"}), 413

    in_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    out_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)

    in_path = in_tmp.name
    out_path = out_tmp.name

    try:
        # 1. Write uploaded bytes to input temp file
        in_tmp.write(raw)
        in_tmp.flush()
        in_tmp.close()
        out_tmp.close()

        # 2. Call Node.js script (patcher.js)
        script_path = os.path.join(os.path.dirname(__file__), "patcher.js")
        node_cmd = ["node", script_path, in_path, out_path]

        # Running subprocess with extended timeout for WASM initialization
        node_res = subprocess.run(
            node_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=300  # 5 minutes max timeout
        )

        if node_res.returncode != 0:
            error_msg = node_res.stderr.strip() or node_res.stdout.strip()
            raise RuntimeError(f"Node execution failed: {error_msg}")

        file_id = uuid.uuid4().hex
        out_name = f'jv_{file_id}.mp4'

        # Cleanup temp files after response is sent
        @after_this_request
        def cleanup(response):
            for path in (in_path, out_path):
                try:
                    if os.path.exists(path):
                        os.remove(path)
                except Exception:
                    pass
            return response

        resp = send_file(out_path, mimetype='video/mp4', as_attachment=True, download_name=out_name)
        resp.headers['X-File-Id'] = file_id
        return resp

    except subprocess.TimeoutExpired:
        cleanup_temp_files(in_path, out_path)
        return jsonify({"error": "Processing timed out (WASM execution took too long)"}), 504
    except Exception as e:
        cleanup_temp_files(in_path, out_path)
        return jsonify({"error": str(e)}), 422

def cleanup_temp_files(*paths):
    for path in paths:
        if os.path.exists(path):
            try:
                os.remove(path)
            except Exception:
                pass

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
