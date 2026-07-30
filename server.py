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
    return jsonify({"status": "ok", "service": "JV 60FPS Server Ready"})

@app.route('/patch', methods=['POST'])
def patch():
    f = request.files.get('video') or request.files.get('file')
    if not f:
        return jsonify({"error": "No video file provided"}), 400

    raw = f.read()
    if not raw:
        return jsonify({"error": "File is empty"}), 400

    in_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    out_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)

    in_path = in_tmp.name
    out_path = out_tmp.name

    try:
        in_tmp.write(raw)
        in_tmp.flush()
        in_tmp.close()
        out_tmp.close()

        script_path = os.path.join(os.path.dirname(__file__), "patcher.py")
        res = subprocess.run(
            ["python", script_path, in_path, out_path],
            capture_output=True,
            text=True,
            timeout=300
        )

        if res.returncode != 0:
            raise RuntimeError(f"Patcher failed: {res.stderr.strip()}")

        file_id = uuid.uuid4().hex
        out_name = f'jv_{file_id}.mp4'

        @after_this_request
        def cleanup(response):
            for p in (in_path, out_path):
                if os.path.exists(p):
                    try: os.remove(p)
                    except Exception: pass
            return response

        resp = send_file(out_path, mimetype='video/mp4', as_attachment=True, download_name=out_name)
        resp.headers['X-File-Id'] = file_id
        return resp

    except Exception as e:
        for p in (in_path, out_path):
            if os.path.exists(p):
                try: os.remove(p)
                except Exception: pass
        return jsonify({"error": str(e)}), 422

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
