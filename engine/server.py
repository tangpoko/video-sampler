"""The Video Sampler editor's local server.

Serves the web page in app/ at /, the JSON API in docs/API.md under /api, and the film proxy,
thumbnails, song and previews under /media. Media answers HTTP Range requests, because a video
player asks for small pieces of a file every time the user seeks.

Only the standard library is used for the web part, so starting the editor never needs an
install that could disturb the CUDA build of torch in this venv.

Usage:
    python server.py [--port 8770]
Then open http://127.0.0.1:8770/
"""
import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))

import project as store            # noqa: E402
import render                      # noqa: E402
import live                        # noqa: E402
import recordings                  # noqa: E402
from project import ApiError       # noqa: E402

ENGINE = Path(__file__).resolve().parent
APP_DIR = store.ROOT / "app"
PYTHON = sys.executable

# Windows keeps its own list of file types and often calls .js plain text, which browsers refuse
# to load as a module. So the types the page needs are spelled out here.
TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".map": "application/json",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4a": "audio/mp4",
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg",
    ".aac": "audio/aac", ".txt": "text/plain; charset=utf-8",
}


# ---- jobs: the slow things, with progress the page can poll ------------------------------------

JOBS = {}
_jobs_lock = threading.Lock()


class Job:
    def __init__(self):
        self.id = uuid.uuid4().hex[:12]
        self.status, self.progress, self.message, self.result = "running", 0.0, "Starting", None

    def update(self, progress=None, message=None):
        if progress is not None:
            self.progress = max(0.0, min(1.0, float(progress)))
        if message:
            self.message = message

    def public(self):
        out = {"status": self.status, "progress": round(self.progress, 3), "message": self.message}
        if self.result is not None:
            out["result"] = self.result
        return out


def start_job(work):
    """Run work(job) on its own thread. What it returns becomes the job's result."""
    job = Job()
    with _jobs_lock:
        JOBS[job.id] = job

    def run():
        try:
            job.result = work(job)
            job.progress, job.status = 1.0, "done"
            if job.message == "Starting":
                job.message = "Done"
        except ApiError as e:
            job.status, job.message = "failed", e.message
        except Exception as e:
            traceback.print_exc()
            job.status, job.message = "failed", f"{type(e).__name__}: {e}"[:400]

    threading.Thread(target=run, daemon=True, name=f"job-{job.id}").start()
    return {"job": job.id}


def run_script(args, on_line=None):
    """Run one of the engine's command-line scripts and hand each line it prints to on_line.
    The scripts already report their own progress this way, so they are run as they are."""
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen([PYTHON, "-u", *map(str, args)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", env=env, cwd=str(store.ROOT))
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        if not line.strip():
            continue
        tail = (tail + [line.strip()])[-6:]
        if on_line:
            on_line(line)
    if proc.wait() != 0:
        raise ApiError("It stopped with an error: " + " | ".join(tail)[-400:], 500)
    return tail


def existing_file(body):
    path = (body or {}).get("path")
    if not isinstance(path, str) or not path.strip():
        raise ApiError("Send the full path of the file, like {\"path\": \"C:/path/to/film.mkv\"}.")
    path = Path(path.strip().strip('"'))
    if not path.is_file():
        raise ApiError(f"There is no file at {path}.", 404)
    return path.resolve()


ANALYSING = {}                      # film path -> job id, so one film is never analysed twice at once
_analysing_lock = threading.Lock()


def new_library(body):
    film = existing_file(body)
    with _analysing_lock:
        jid = ANALYSING.get(str(film))
        if jid and JOBS.get(jid) and JOBS[jid].status == "running":
            return {"job": jid}
        started = _new_library(film)
        if "job" in started:
            ANALYSING[str(film)] = started["job"]
        return started


def _new_library(film):
    # The same film again opens the library it already has. A different film with the same
    # file name gets a number on the end, so nothing is overwritten.
    base = store.slug(film.stem)
    lib_id, n = base, 2
    while (store.LIBRARY_DIR / lib_id).exists():
        info = store.LIBRARY_DIR / lib_id / "analysis.json"
        if info.exists() and Path(json.loads(info.read_text(encoding="utf-8")).get("film_path", "")) == film:
            return start_job(lambda job: job.update(1, "This film was already analysed") or {"id": lib_id})
        lib_id, n = f"{base}-{n}", n + 1

    def work(job):
        job.update(0.01, "Loading the analyser")

        def on_line(line):
            m = re.match(r"\s*([\d.]+)%", line)
            if m:
                # Reading the film is nearly all of the time. Scoring the clips after is quick.
                job.update(0.03 + 0.92 * float(m.group(1)) / 100, "Reading the film: " + line.strip())
            else:
                job.update(None, line.strip()[:200])
        run_script([ENGINE / "analyse.py", film, "--out", store.LIBRARY_DIR / lib_id], on_line)
        if not (store.LIBRARY_DIR / lib_id / "analysis.json").exists():
            raise ApiError("The analyser finished without writing a library.", 500)
        job.update(1, "Done")
        return {"id": lib_id}
    return start_job(work)


def new_song(body):
    body = body or {}
    audio = existing_file(body)
    snippet = bool(body.get("snippet"))
    length = body.get("length", 180)
    if not isinstance(length, (int, float)) or isinstance(length, bool) or not 10 <= length <= 600:
        raise ApiError("length is the snippet length in seconds, from 10 to 600.")
    base = store.slug(audio.stem)
    song_id, n = base, 2
    while (store.SONGS_DIR / f"{song_id}.json").exists() or (snippet and (store.SONGS_DIR / f"{song_id}.wav").exists()):
        info = store.SONGS_DIR / f"{song_id}.json"
        if not snippet and info.exists() and Path(json.loads(info.read_text(encoding="utf-8")).get("song", "")) == audio:
            return start_job(lambda job: job.update(1, "This song was already analysed") or {"id": song_id})
        song_id, n = f"{base}-{n}", n + 1

    def work(job):
        src = audio
        if snippet:
            job.update(0.05, "Looking for the liveliest stretch of the mix")
            src = store.SONGS_DIR / f"{song_id}.wav"
            run_script([ENGINE / "find_snippet.py", audio, "--out", src, "--length", length],
                       lambda line: job.update(None, line.strip()[:200]))
        job.update(0.5 if snippet else 0.1, "Finding the beats and sections")
        out = store.SONGS_DIR / f"{song_id}.json"
        run_script([ENGINE / "song.py", src, "--out", out])
        job.update(0.9, "Drawing the waveform")
        store.load_song(song_id)        # works out the peaks and saves them
        job.update(1, "Done")
        return {"id": song_id}
    return start_job(work)


def export_project(pid, body):
    p = store.get_project(pid)
    width = (body or {}).get("width", 1920)
    if not isinstance(width, int) or isinstance(width, bool) or not 320 <= width <= 3840:
        raise ApiError("width has to be a whole number from 320 to 3840.")
    edit, version = p.as_edit()
    if not Path(edit["film"]).is_file():
        raise ApiError(f"The original film is not at {edit['film']}. Exports are made from it, not from the small copy.", 404)

    def work(job):
        name = f"{pid}-v{version}-{width // 4 * 4}.mp4"
        out = p.folder / "exports" / name
        job.update(0.0, "Rendering cuts from the original film")
        render.render_edit(edit, out, draft=False, width=width,
                           progress=lambda done, total: job.update(0.97 * done / total, f"Rendered {done} of {total} cuts"))
        job.update(1, "Done")
        return {"path": str(out), "url": f"/media/export/{pid}/{name}"}
    return start_job(work)


def new_live_copy(body):
    source = existing_file(body)
    key = str(source)
    with live._running_lock:
        jid = live.RUNNING.get(key)
        if jid and JOBS.get(jid) and JOBS[jid].status == "running":
            return {"job": jid}

        def work(job):
            try:
                return live.make_copy(source, job)
            finally:
                with live._running_lock:
                    live.RUNNING.pop(key, None)
        started = start_job(work)
        live.RUNNING[key] = started["job"]
        return started


def new_recording(handler):
    """The live player's recording arrives as raw WebM bytes, not JSON, so it is read here."""
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        raise ApiError("The recording is empty.")
    try:
        duration = float(handler.headers.get("X-Duration") or 0)
    except ValueError:
        duration = 0
    webm = recordings.receive(handler.rfile, length)
    return start_job(lambda job: recordings.convert(webm, duration, job))


# ---- routes ------------------------------------------------------------------------------------

def P(pid):
    return store.get_project(pid)


def open_project(pid):
    p = P(pid)
    p.ensure_preview()
    return p.public()


def get_job(jid):
    job = JOBS.get(jid)
    if job is None:
        raise ApiError("There is no job with that id.", 404)
    return job.public()


def remove_project(pid):
    store.delete_project(pid)
    return {"ok": True}


ID = r"([^/]+)"
ROUTES = [(method, re.compile(f"^{pattern}$"), fn) for method, pattern, fn in [
    ("GET", "/api/live", lambda b: live.list_copies()),
    ("POST", "/api/live", lambda b: new_live_copy(b)),
    ("GET", f"/api/live/{ID}/clips", lambda b, cid: live.copy_clips(cid)),
    ("POST", "/api/recordings/(.+)/reveal", lambda b, name: recordings.reveal(name)),
    ("GET", "/api/libraries", lambda b: store.list_libraries()),
    ("POST", "/api/libraries", lambda b: new_library(b)),
    ("GET", f"/api/libraries/{ID}/clips", lambda b, lib: store.library_clips(lib)),
    ("GET", "/api/songs", lambda b: store.list_songs()),
    ("POST", "/api/songs", lambda b: new_song(b)),
    ("GET", "/api/projects", lambda b: store.list_projects()),
    ("POST", "/api/projects", lambda b: store.create_project(b).public()),
    ("GET", f"/api/projects/{ID}", lambda b, pid: open_project(pid)),
    ("DELETE", f"/api/projects/{ID}", lambda b, pid: remove_project(pid)),
    ("GET", f"/api/jobs/{ID}", lambda b, jid: get_job(jid)),
    ("POST", f"/api/projects/{ID}/cuts/{ID}/delete", lambda b, pid, cut: P(pid).delete_cut(cut)),
    ("POST", f"/api/projects/{ID}/cuts/{ID}/split", lambda b, pid, cut: P(pid).split_cut(cut, b)),
    ("POST", f"/api/projects/{ID}/cuts/{ID}/move_start", lambda b, pid, cut: P(pid).move_start(cut, b)),
    ("POST", f"/api/projects/{ID}/cuts/{ID}/clip", lambda b, pid, cut: P(pid).swap_clip(cut, b)),
    ("POST", f"/api/projects/{ID}/cuts/{ID}/reroll", lambda b, pid, cut: P(pid).reroll_cut(cut)),
    ("PATCH", f"/api/projects/{ID}/cuts/{ID}", lambda b, pid, cut: P(pid).patch_cut(cut, b)),
    ("POST", f"/api/projects/{ID}/reroll", lambda b, pid: P(pid).reroll_all(b)),
    ("PATCH", f"/api/projects/{ID}/settings", lambda b, pid: P(pid).patch_settings(b)),
    ("POST", f"/api/projects/{ID}/undo", lambda b, pid: P(pid).undo()),
    ("POST", f"/api/projects/{ID}/redo", lambda b, pid: P(pid).redo()),
    ("GET", f"/api/projects/{ID}/preview", lambda b, pid: P(pid).preview.status()),
    ("POST", f"/api/projects/{ID}/export", lambda b, pid: export_project(pid, b)),
]]


def media_file(parts):
    """The file on disk behind a /media path, or None."""
    if len(parts) == 3 and parts[0] == "library" and parts[2] == "proxy.mp4":
        entry = store.load_library(parts[1])
        return entry["dir"] / entry["lib"].get("proxy", "proxy.mp4")
    if len(parts) == 4 and parts[0] == "library" and parts[2] == "thumbs":
        return store.LIBRARY_DIR / store.safe_id(parts[1]) / "thumbs" / store.safe_id(parts[3])
    if len(parts) == 2 and parts[0] == "live":
        return live.LIVE_DIR / store.safe_id(parts[1])
    if len(parts) == 2 and parts[0] == "song":
        return Path(store.load_song(parts[1])["song"])
    if len(parts) == 3 and parts[0] == "preview":
        return store.PROJECTS_DIR / store.safe_id(parts[1]) / "preview" / store.safe_id(parts[2])
    if len(parts) == 2 and parts[0] == "recording":
        return recordings.recording_path(parts[1])
    if len(parts) == 3 and parts[0] == "export":
        return store.PROJECTS_DIR / store.safe_id(parts[1]) / "exports" / store.safe_id(parts[2])
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"       # keeps the connection open between the page's many requests

    def log_message(self, *args):
        pass

    # ---- answers ----

    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error_json(self, message, status):
        self.send_json({"error": message}, status)

    def send_file(self, path, cache="no-cache"):
        """Send a file, or the part of it a Range header asks for."""
        path = Path(path)
        if not path.is_file():
            return self.send_error_json("There is no such file.", 404)
        try:
            f = open(path, "rb")
        except OSError:
            return self.send_error_json("That file could not be opened.", 404)
        with f:
            size = os.fstat(f.fileno()).st_size
            start, end, status = 0, size - 1, 200
            m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", "").strip())
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))      # "the last N bytes"
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
            length = end - start + 1 if size else 0
            self.send_response(status)
            self.send_header("Content-Type", TYPES.get(path.suffix.lower(), "application/octet-stream"))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Cache-Control", cache)
            self.end_headers()
            if self.command == "HEAD":
                return
            f.seek(start)
            left = length
            try:
                while left > 0:
                    chunk = f.read(min(256 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionError):
                # The browser drops range requests all the time while seeking. The rest of this
                # answer was never sent, so the connection cannot be reused.
                self.close_connection = True

    # ---- requests ----

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if not raw.strip():
            return {}
        try:
            body = json.loads(raw)
        except ValueError:
            raise ApiError("The request body is not valid JSON.")
        if not isinstance(body, dict):
            raise ApiError("The request body has to be a JSON object.")
        return body

    def handle_any(self):
        path = unquote(urlsplit(self.path).path)
        method = "GET" if self.command == "HEAD" else self.command
        try:
            if method == "POST" and path == "/api/recordings":
                return self.send_json(new_recording(self))
            body = self.read_body() if method in ("POST", "PATCH", "PUT", "DELETE") else {}
            if path.startswith("/api/"):
                known = False
                for m, pattern, fn in ROUTES:
                    hit = pattern.match(path)
                    if hit:
                        known = True
                        if m == method:
                            return self.send_json(fn(body, *hit.groups()))
                if known:
                    return self.send_error_json(f"{method} is not allowed on this address.", 405)
                return self.send_error_json("There is no such API address.", 404)
            if method != "GET":
                return self.send_error_json(f"{method} is not allowed on this address.", 405)
            if path.startswith("/media/"):
                target = media_file([p for p in path[len("/media/"):].split("/") if p])
                if target is None:
                    return self.send_error_json("There is no such media address.", 404)
                # A preview or export file never changes once written, so the browser may keep it.
                fixed = path.startswith(("/media/preview/", "/media/export/"))
                return self.send_file(target, "max-age=3600" if fixed else "no-cache")
            return self.send_static(path)
        except ApiError as e:
            self.send_error_json(e.message, e.status)
        except (BrokenPipeError, ConnectionError):
            self.close_connection = True
        except Exception as e:
            traceback.print_exc()
            try:
                self.send_error_json(f"The server hit a problem: {type(e).__name__}: {e}", 500)
            except Exception:
                self.close_connection = True

    def send_static(self, path):
        """The web page. Only files inside app/ can be reached."""
        rel = path.lstrip("/") or "index.html"
        target = (APP_DIR / rel).resolve()
        if target.is_dir():
            target = target / "index.html"
        if APP_DIR.resolve() not in target.parents or not target.is_file():
            return self.send_error_json("There is no such page.", 404)
        self.send_file(target)

    do_GET = do_HEAD = do_POST = do_PATCH = do_DELETE = do_PUT = handle_any


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Windows lets a second server take a port that is already in use when this is on, and then
    # the two answer requests at random. Off, a second start fails with a clear message.
    allow_reuse_address = False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8770)
    a = ap.parse_args()
    try:
        httpd = Server(("127.0.0.1", a.port), Handler)
    except OSError as e:
        sys.exit(f"could not open port {a.port}, is the editor already running? ({e})")
    made = store.ensure_default_project()
    if made:
        print(f"made the starter project {made.id}, rendering its first preview", flush=True)
    print(f"Video Sampler editor: http://127.0.0.1:{a.port}/   (Ctrl+C to stop)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()
