"""
JV-60FPS Server
Imports patch logic from patcher.py — update patcher.py to change method.
"""

import os, uuid, tempfile
from flask import Flask, request, send_file, jsonify
from patcher import patch_shark_sample_table

app = Flask(__name__)
MAX_SIZE = 500 * 1024 * 1024

@app.after_request
def cors(r):
    r.headers['Access-Control-Allow-Origin']  = '*'
    r.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    r.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return r

@app.route('/')
def index():
    return jsonify({"status": "ok", "service": "JV Shark Sample Table Server"})

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
        return jsonify({"error": "No video field"}), 400

    raw = f.read()
    if not raw:
        return jsonify({"error": "Empty file"}), 400
    if len(raw) > MAX_SIZE:
        return jsonify({"error": "File too large (max 500MB)"}), 413

    try:
        output, real_samples, fake_samples = patch_shark_sample_table(raw)
    except Exception as e:
        return jsonify({"error": str(e)}), 422

    file_id  = uuid.uuid4().hex
    out_name = f'jv_{file_id}.mp4'

    tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    tmp.write(output)
    tmp.flush()
    tmp.close()

    resp = send_file(tmp.name, mimetype='video/mp4', as_attachment=True, download_name=out_name)
    resp.headers['X-File-Id']      = file_id
    resp.headers['X-Real-Samples'] = str(real_samples)
    resp.headers['X-Fake-Samples'] = str(fake_samples)
    return resp

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
