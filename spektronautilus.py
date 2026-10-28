#!/usr/bin/env python3
"""Spektronautilus for Linux: the whole website, running on your own computer.

It starts a small web server that only answers to this computer (127.0.0.1), and opens the site in Chrome/Chromium in its own
window. Compared with the web version you get:
  * the real ffmpeg for converting, loops and filters (much faster than in the browser, no memory limit)
  * a browser launched with settings made for live visuals (no slowing down of background windows, autoplay allowed)
  * no internet needed for the mixers and tools (finding online loops still needs it)
Only Python 3.8+ is needed (nothing to pip install). ffmpeg is optional but recommended.

  spektronautilus.py                 start and open the window
  spektronautilus.py --no-browser    only start the server, then open http://127.0.0.1:8765/ yourself
  spektronautilus.py --window        open in a normal browser window instead of an app window
  spektronautilus.py --port 9000     use another port (the browser remembers your settings per port, so keep it the same)
"""
import glob, argparse, atexit, http.server, json, os, re, shutil, signal, socket, subprocess, sys, tempfile, threading, time, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_PORT = 8765
APP_NAME = "spektronautilus"
CHROME_FLAGS = [                       # made for live visuals: never throttle a window that is in the background or behind the output window
    "--autoplay-policy=no-user-gesture-required", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", "--enable-gpu-rasterization", "--no-first-run", "--no-default-browser-check",
]
BROWSERS = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome", "brave-browser", "microsoft-edge"]

def find_docs():
    for p in (HERE / "docs", HERE.parent / "docs"):
        if (p / "index.html").exists(): return p
    sys.exit("Could not find the 'docs' folder next to this script.")

# ------------------------------------------------------------------ ffmpeg
def ffmpeg_info():
    exe = shutil.which("ffmpeg")
    if not exe: return {"ok": False, "why": "ffmpeg is not installed"}
    try:
        v = subprocess.run([exe, "-hide_banner", "-version"], capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
        enc = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=10).stdout
    except Exception as e:
        return {"ok": False, "why": str(e)}
    m = re.search(r"ffmpeg version (\S+)", v)
    if "libx264" not in enc: return {"ok": False, "why": "this ffmpeg has no H.264 encoder (libx264)"}
    return {"ok": True, "version": m.group(1) if m else "", "cores": os.cpu_count() or 1, "path": exe}

# ------------------------------------------------------------------ Video2X (AI upscaling, optional, installed by the user)
def v2x_find():
    """Video2X is a separate program (AppImage, AUR or your own build). We never ship it, we only start it if it is there."""
    cands = [os.environ.get("SPEKTRO_VIDEO2X", ""), shutil.which("video2x") or "", str(Path.home() / ".local/bin/video2x")]
    for pat in ("~/Applications/*ideo2*", "~/Downloads/*ideo2*.AppImage", "~/.local/bin/*ideo2*.AppImage", "/opt/video2x/*"):
        cands += sorted(glob.glob(os.path.expanduser(pat)), key=lambda x: -os.path.getmtime(x))
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK): return c
    return ""

def v2x_info():
    exe = v2x_find()
    if not exe: return {"ok": False, "why": "Video2X was not found"}
    ver = ""
    try:
        o = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=15)
        ver = ((o.stdout or "") + (o.stderr or "")).strip().splitlines()[0][:60] if (o.stdout or o.stderr).strip() else ""
    except Exception:
        pass
    return {"ok": True, "path": exe, "version": ver}

# Only these options (with values of the right shape) can reach Video2X. File names must stay inside the temporary folder.
V2X_FLAGS = {"-p": r"(realesrgan|libplacebo)", "-s": r"[2-4]", "-c": r"(libx264|libx265|libx264rgb)", "-e": r"(crf=\d{1,2}|preset=[a-z]+)", "-g": r"\d{1,2}",
             "--realesrgan-model": r"[\w.+-]{1,60}", "--libplacebo-shader": r"[\w.+-]{1,60}", "-w": r"\d{2,5}", "-h": r"\d{2,5}"}
def v2x_args_ok(args, st):
    if not isinstance(args, list) or not args or not all(isinstance(a, str) for a in args) or len(args) % 2: return False
    seen = set()
    for i in range(0, len(args), 2):
        k, v = args[i], args[i + 1]
        if k in ("-i", "-o"):
            if k in seen or v.startswith(("-", "/")) or ".." in v.replace("\\", "/").split("/") or ":" in v or not SAFE_ARG.match(v): return False
            try: st.safe(v)
            except ValueError: return False
        elif k in V2X_FLAGS:
            if not re.fullmatch(V2X_FLAGS[k], v): return False
        else: return False
        seen.add(k)
    return "-i" in seen and "-o" in seen

PCT = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")
FRAC = re.compile(r"(\d+)\s*/\s*(\d+)")

SAFE_ARG = re.compile(r"^(?!/)(?!.*(^|[\\/])\.\.([\\/]|$))(?!.*:\/\/)(?!(file|pipe|http|https|tcp|udp|rtp|rtsp|concat|subfile|data|crypto|ftp|unix|async|cache|hls|md5)\s*:)(?!.*(movie=|subtitles=|fontfile|textfile|=/)).*$", re.S | re.I)   # no absolute paths, no .., no urls: ffmpeg may only touch the work folder
DUR = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
TIME = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")
secs = lambda m: int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])

class State:
    def __init__(self, docs, port):
        self.docs, self.port = docs, port
        self.work = Path(tempfile.mkdtemp(prefix="spektronautilus-"))
        self.ff = ffmpeg_info(); self.v2x = v2x_info(); self.procs = set(); self.lock = threading.Lock()
        atexit.register(self.cleanup)
    def cleanup(self):
        self.kill()
        shutil.rmtree(self.work, ignore_errors=True)
    def kill(self):
        with self.lock:
            for p in list(self.procs):
                try: p.kill()
                except Exception: pass
    def safe(self, rel):
        rel = urllib.parse.unquote(rel).lstrip("/")
        p = (self.work / rel).resolve()
        if p != self.work and self.work not in p.parents: raise ValueError("bad path")
        return p

class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    st: State = None
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
    def _deny(self, code=403, msg="Forbidden"):
        self.send_response(code); self.send_header("Content-Type", "text/plain"); self.end_headers(); self.wfile.write(msg.encode())
    def _host_ok(self):
        h = (self.headers.get("Host") or "").lower()
        return h in (f"127.0.0.1:{self.st.port}", f"localhost:{self.st.port}")           # stops DNS-rebinding tricks from other websites
    def _api_ok(self):
        return self._host_ok() and self.headers.get("X-Spk") == "1"                       # a custom header can not be sent by other websites without a CORS check
    def _json(self, obj, code=200):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if not self._host_ok(): return self._deny()
        if self.path.startswith("/api/"):
            if not self._api_ok(): return self._deny()
            if self.path == "/api/native": return self._json({**self.st.ff, "v2x": self.st.v2x})
            if self.path == "/api/v2x-gpus":
                if not self.st.v2x.get("ok"): return self._json({"ok": False, "why": self.st.v2x.get("why")})
                try:
                    o = subprocess.run([self.st.v2x["path"], "--list-gpus"], capture_output=True, text=True, timeout=40, cwd=self.st.work)
                    text = ((o.stdout or "") + "\n" + (o.stderr or "")).splitlines()
                except Exception as e:
                    return self._json({"ok": False, "why": str(e)})
                return self._json({"ok": True, "lines": [l.strip() for l in text if l.strip()][-20:]})
            if self.path == "/api/ping": return self._json({"app": APP_NAME})
            if self.path.startswith("/api/fs/"):
                try: p = self.st.safe(self.path[8:])
                except ValueError: return self._deny(400, "Bad path")
                if not p.is_file(): return self._deny(404, "Not found")
                self.send_response(200); self.send_header("Content-Type", "application/octet-stream"); self.send_header("Content-Length", str(p.stat().st_size)); self.end_headers()
                with open(p, "rb") as f: shutil.copyfileobj(f, self.wfile, 1 << 20)
                return
            return self._deny(404, "Not found")
        return super().do_GET()
    def do_HEAD(self):
        return super().do_HEAD() if self._host_ok() else self._deny()

    def do_PUT(self):
        if not (self.path.startswith("/api/fs/") and self._api_ok()): return self._deny()
        try: p = self.st.safe(self.path[8:])
        except ValueError: return self._deny(400, "Bad path")
        n = int(self.headers.get("Content-Length") or 0); p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "wb") as f:
            while n > 0:
                c = self.rfile.read(min(n, 1 << 20))
                if not c: break
                f.write(c); n -= len(c)
        self._json({"ok": True})

    def do_DELETE(self):
        if not (self.path.startswith("/api/fs/") and self._api_ok()): return self._deny()
        try: p = self.st.safe(self.path[8:])
        except ValueError: return self._deny(400, "Bad path")
        if p == self.st.work: return self._deny(400, "Bad path")
        shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        self._json({"ok": True})

    def _v2x_exec(self):
        if not self.st.v2x.get("ok"): return self._deny(503, "Video2X is not available")
        try: args = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        except Exception: return self._deny(400, "Bad request")
        if not v2x_args_ok(args, self.st): return self._deny(400, "Arguments not allowed")
        self.send_response(200); self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
        try:
            proc = subprocess.Popen([self.st.v2x["path"], *args], cwd=self.st.work, stdin=subprocess.DEVNULL, stderr=subprocess.STDOUT, stdout=subprocess.PIPE, preexec_fn=lambda: os.nice(5))
        except Exception as e:
            self.wfile.write((json.dumps({"code": 127, "log": [str(e)]}) + "\n").encode()); return
        with self.st.lock: self.st.procs.add(proc)
        log, last, buf = [], 0.0, b""
        try:
            while True:
                chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
                if not chunk: break
                buf += chunk; parts = re.split(rb"[\r\n]+", buf); buf = parts.pop()
                for raw in parts:
                    line = raw.decode("utf-8", "replace")
                    if not line.strip(): continue
                    log.append(line[:300])
                    p = None
                    m = FRAC.search(line)
                    if m and int(m[2]) > 0 and int(m[1]) <= int(m[2]): p = int(m[1]) / int(m[2])
                    else:
                        m = PCT.search(line)
                        if m and float(m[1]) <= 100: p = float(m[1]) / 100
                    if p is not None and p - last >= 0.01:
                        last = p; self.wfile.write((json.dumps({"p": round(p, 3)}) + "\n").encode()); self.wfile.flush()
            if buf: log.append(buf.decode("utf-8", "replace")[:300])
            code = proc.wait()
            self.wfile.write((json.dumps({"code": code, "log": log[-300:]}) + "\n").encode())
        except (BrokenPipeError, ConnectionResetError):
            proc.kill()
        finally:
            with self.st.lock: self.st.procs.discard(proc)

    def do_POST(self):
        if not self._api_ok(): return self._deny()
        if self.path == "/api/kill": self.st.kill(); return self._json({"ok": True})
        if self.path == "/api/v2x-exec": return self._v2x_exec()
        if self.path != "/api/exec": return self._deny(404, "Not found")
        if not self.st.ff.get("ok"): return self._deny(503, "ffmpeg is not available")
        try: args = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        except Exception: return self._deny(400, "Bad request")
        if not isinstance(args, list) or not all(isinstance(a, str) and SAFE_ARG.match(a) for a in args): return self._deny(400, "Arguments not allowed")
        self.send_response(200); self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
        try:
            proc = subprocess.Popen([self.st.ff["path"], "-nostdin", *args], cwd=self.st.work, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, preexec_fn=lambda: os.nice(5))
        except Exception as e:
            self.wfile.write((json.dumps({"code": 127, "log": [str(e)]}) + "\n").encode()); return
        with self.st.lock: self.st.procs.add(proc)
        log, dur, last, buf = [], None, 0.0, b""
        try:
            while True:
                chunk = proc.stderr.read1(4096) if hasattr(proc.stderr, "read1") else proc.stderr.read(4096)
                if not chunk: break
                buf += chunk; parts = re.split(rb"[\r\n]+", buf); buf = parts.pop()
                for raw in parts:
                    line = raw.decode("utf-8", "replace")
                    if not line: continue
                    log.append(line)
                    if dur is None:
                        m = DUR.search(line)
                        if m: dur = secs(m) or None
                    m = TIME.search(line)
                    if m and dur:
                        p = min(1.0, secs(m) / dur)
                        if p - last >= 0.01:
                            last = p; self.wfile.write((json.dumps({"p": round(p, 3)}) + "\n").encode()); self.wfile.flush()
            if buf: log.append(buf.decode("utf-8", "replace"))
            code = proc.wait()
            self.wfile.write((json.dumps({"code": code, "log": log[-4000:]}) + "\n").encode())
        except (BrokenPipeError, ConnectionResetError):
            proc.kill()                                       # the page was closed or Stop was pressed
        finally:
            with self.st.lock: self.st.procs.discard(proc)

def port_free(port):
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: s.bind(("127.0.0.1", port)); return True
        except OSError: return False

def already_running(port):
    try:
        r = urllib.request.Request(f"http://127.0.0.1:{port}/api/ping", headers={"X-Spk": "1"})
        return json.load(urllib.request.urlopen(r, timeout=1)).get("app") == APP_NAME
    except Exception:
        return False

def find_browser():
    env = os.environ.get("SPEKTRO_BROWSER")
    if env: return shutil.which(env) or env
    for b in BROWSERS:
        p = shutil.which(b)
        if p: return p
    return None

def main():
    ap = argparse.ArgumentParser(description="Spektronautilus for Linux")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT); ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--window", action="store_true", help="normal browser window instead of an app window")
    ap.add_argument("--docs", help="folder with the website (default: next to this script)"); ap.add_argument("--path", default="", help="page to open, e.g. live-dj/")
    a = ap.parse_args()
    docs = Path(a.docs).resolve() if a.docs else find_docs()
    port = a.port
    if already_running(port):
        print(f"Spektronautilus is already running on port {port}. Opening a window for it.")
        if not a.no_browser: open_browser(port, a, docs)
        return
    if not port_free(port):
        print(f"Port {port} is busy, using a free one. (Your saved settings belong to port {port}, so close the other program if you can.)")
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    st = State(docs, port); Handler.st = st
    handler = lambda *x, **k: Handler(*x, directory=str(docs), **k)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/{a.path}"
    print(f"Spektronautilus is running at {url}")
    print("AI upscaling with Video2X: " + (f"ON ({st.v2x['path']})" if st.v2x.get("ok") else "OFF (optional, see README-LINUX.txt)"))
    print("Fast converting with ffmpeg: " + (f"ON (ffmpeg {st.ff['version']}, {st.ff['cores']} cores)" if st.ff.get("ok") else f"OFF ({st.ff.get('why')}). Install ffmpeg (for example: sudo apt install ffmpeg) to turn it on."))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        proc = None if a.no_browser else open_browser(port, a, docs)
        if proc:
            t0 = time.time(); proc.wait()
            if time.time() - t0 < 4: print("The window was handed to a browser that was already open. Press Ctrl+C here when you are done."); threading.Event().wait()
        else:
            print("Press Ctrl+C to stop."); threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown(); st.cleanup()

def open_browser(port, a, docs):
    url = f"http://127.0.0.1:{port}/{a.path}"; b = find_browser()
    if not b:
        print("Could not find Chrome or Chromium. Opening your default browser. For the best result for live visuals install Google Chrome or Chromium.")
        try: subprocess.Popen(["xdg-open", url])
        except Exception: print("Open this address yourself:", url)
        return None
    prof = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / APP_NAME / "browser"; prof.mkdir(parents=True, exist_ok=True)
    cmd = [b, f"--user-data-dir={prof}", *CHROME_FLAGS, *(["--new-window", url] if a.window else [f"--app={url}"])]
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    main()
