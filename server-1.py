"""
JV-60FPS Server
Imports patch logic from patcher.py — update patcher.py to change method.
Rate limit: 4 uploads per IP per week.
"""

import os, uuid, tempfile, time, threading
from flask import Flask, request, send_file, jsonify
from patcher import patch_shark_sample_table

app = Flask(__name__)
MAX_SIZE = 500 * 1024 * 1024

# ── CORS ──────────────────────────────────────────────────────────
@app.after_request
def cors(r):
    r.headers['Access-Control-Allow-Origin']  = '*'
    r.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    r.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return r

# ── Routes ────────────────────────────────────────────────────────
@app.route('/')
def index():
    return jsonify({"status": "ok", "service": "JV Shark Sample Table Server"})

@app.route('/verify/<api_key>', methods=['GET'])
@app.route('/verify/<api_key>/<token>', methods=['GET'])
def verify(api_key, token=None):
    # Allowed IDs — add yours here
    ALLOWED = {'7082829394'}
    if api_key in ALLOWED:
        return jsonify({"allowed": True, "username": "JV"})
    return jsonify({"allowed": False, "reason": "denied"})

@app.route('/health')
def health():
    return jsonify({"status": "ok"})

@app.route('/patch', methods=['OPTIONS'])
def patch_options():
    return '', 204

@app.route('/patch', methods=['POST'])
def patch():
    # Auth token — extension sends this with every request
    token = request.form.get('token', '')
    if token != '7082829394':
        return jsonify({"error": "Unauthorized — authenticate first"}), 401

    ip = get_ip()
    allowed, used, left, reset_in = check_rate_limit(ip)

    if not allowed:
        return jsonify({
            "error": f"Weekly limit reached ({WEEKLY_LIMIT} uploads/week). "
                     f"Resets in {fmt_time(reset_in)}.",
            "limit":    WEEKLY_LIMIT,
            "used":     used,
            "left":     0,
            "reset_in": reset_in,
        }), 429

    # Token check — reject without valid token
    token = request.form.get('token', '')
    if token != '7082829394':
        with rate_lock:
            if ip in rate_store and rate_store[ip]['timestamps']:
                rate_store[ip]['timestamps'].pop()
        return jsonify({"error": "Unauthorized"}), 401

    f = request.files.get('video') or request.files.get('file')
    if not f:
        with rate_lock:
            if ip in rate_store and rate_store[ip]['timestamps']:
                rate_store[ip]['timestamps'].pop()
        return jsonify({"error": "No video field"}), 400

    raw = f.read()
    if not raw:
        with rate_lock:
            if ip in rate_store and rate_store[ip]['timestamps']:
                rate_store[ip]['timestamps'].pop()
        return jsonify({"error": "Empty file"}), 400

    if len(raw) > MAX_SIZE:
        with rate_lock:
            if ip in rate_store and rate_store[ip]['timestamps']:
                rate_store[ip]['timestamps'].pop()
        return jsonify({"error": "File too large (max 500MB)"}), 413

    try:
        output, real_samples, fake_samples = patch_shark_sample_table(raw)
    except Exception as e:
        # Don't count failed patches against limit
        with rate_lock:
            if ip in rate_store and rate_store[ip]['timestamps']:
                rate_store[ip]['timestamps'].pop()
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
    resp.headers['X-Uploads-Used'] = str(used)
    resp.headers['X-Uploads-Left'] = str(left)
    return resp

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
