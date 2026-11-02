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

WIN = os.name == "nt"
HERE = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
# helper programs run politely in the background (and without a console window on Windows)
NOWIN = {"creationflags": 0x08000000} if WIN else {}      # no console window flashing on Windows
PRIO = {"creationflags": 0x00004000 | 0x08000000} if WIN else {"preexec_fn": lambda: os.nice(5)}
DEFAULT_PORT = 8765
MIN_FREE_MB = 500                      # always leave this much room for results
APP_NAME = "spektronautilus"
CHROME_FLAGS = [                       # made for live visuals: never throttle a window that is in the background or behind the output window
    "--autoplay-policy=no-user-gesture-required", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", "--enable-gpu-rasterization", "--no-first-run", "--no-default-browser-check",
]
EXTRA_FLAGS = os.environ.get("SPEKTRO_CHROME_FLAGS", "").split()      # for experts, e.g. the NVIDIA video-decoding recipe in README-LINUX.txt
WIN_BROWSERS = [r"%ProgramFiles%\Google\Chrome\Application\chrome.exe", r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe", r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
                r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe", r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe", r"%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"]
FLATPAK_BROWSERS = ["com.google.Chrome", "org.chromium.Chromium", "com.brave.Browser", "com.microsoft.Edge"]
BROWSERS = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome", "brave-browser", "microsoft-edge"]

def find_docs():
    for p in (HERE / "docs", HERE.parent / "docs"):
        if (p / "index.html").exists(): return p
    sys.exit("Could not find the 'docs' folder next to this script.")

# ------------------------------------------------------------------ ffmpeg
def ffmpeg_info():
    exe = next((str(c) for c in (HERE / "ffmpeg" / "ffmpeg.exe", HERE / "ffmpeg" / "ffmpeg", HERE / "ffmpeg.exe") if c.exists()), None) or shutil.which("ffmpeg")
    if not exe: return {"ok": False, "why": "ffmpeg is not installed"}
    try:
        v = subprocess.run([exe, "-hide_banner", "-version"], capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
        enc = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=10).stdout
    except Exception as e:
        return {"ok": False, "why": str(e)}
    m = re.search(r"ffmpeg version (\S+)", v)
    if "libx264" not in enc: return {"ok": False, "why": "this ffmpeg has no H.264 encoder (libx264)"}
    return {"ok": True, "version": m.group(1) if m else "", "cores": os.cpu_count() or 1, "path": exe, "hw": []}

HW_ENCODERS = ("h264_nvenc", "h264_vaapi", "h264_qsv")
def hw_probe(exe):
    """Which graphics-card H.264 encoders really work here? Listing them is not enough (ffmpeg lists what it was built with), so each one encodes a single test frame."""
    try: enc = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=10).stdout
    except Exception: return []
    found = []
    for e in HW_ENCODERS:
        if e not in enc: continue
        pre = ["-init_hw_device", "vaapi=hw:" + render_node() + "", "-filter_hw_device", "hw"] if e == "h264_vaapi" else []
        vf = "format=nv12,hwupload" if e == "h264_vaapi" else "format=yuv420p"
        try:
            r = subprocess.run([exe, "-hide_banner", "-nostdin", *pre, "-f", "lavfi", "-i", "color=c=black:s=256x144:r=25:d=0.2", "-vf", vf, "-frames:v", "2", "-c:v", e, "-f", "null", "-"],
                               capture_output=True, timeout=20, **NOWIN)
            if r.returncode == 0: found.append(e)
        except Exception: pass
    return found

def gpu_stats():
    """Temperature, memory and load of an NVIDIA card (nvidia-smi comes with the driver). Other cards: not available."""
    exe = shutil.which("nvidia-smi")
    if not exe: return {"ok": False, "why": "no nvidia-smi"}
    try:
        o = subprocess.run([exe, "--query-gpu=name,temperature.gpu,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5, **NOWIN)
        gpus = []
        for line in o.stdout.strip().splitlines():
            n, t, mu, mt, ut = [x.strip() for x in line.split(",")]
            gpus.append({"name": n, "temp": int(float(t)), "mem_used": int(float(mu)), "mem_total": int(float(mt)), "util": int(float(ut))})
        return {"ok": bool(gpus), "gpus": gpus} if gpus else {"ok": False, "why": "no card answered"}
    except Exception as e:
        return {"ok": False, "why": str(e)[:80]}

def sensors():
    """Laptops: processor temperature and whether we run on battery, read from /sys (no extra program needed). SPEKTRO_SYSFS lets tests point at a fake folder."""
    root = Path(os.environ.get("SPEKTRO_SYSFS", "/sys")); temps, battery = [], None
    try:
        for z in sorted(root.glob("class/thermal/thermal_zone*")):
            try:
                kind = (z / "type").read_text().strip(); t = int((z / "temp").read_text()) / 1000
                if kind in ("x86_pkg_temp", "cpu-thermal", "TCPU", "acpitz") or kind.startswith("coretemp"): temps.append(t)
            except Exception: pass
        for ps in sorted(root.glob("class/power_supply/*")):
            try:
                if (ps / "type").read_text().strip() == "Battery": battery = (ps / "status").read_text().strip() == "Discharging"
            except Exception: pass
    except Exception: pass
    return {"ok": bool(temps) or battery is not None, "cpu_temp": round(max(temps)) if temps else None, "on_battery": battery}

def render_node():
    nodes = sorted(glob.glob("/dev/dri/renderD*")); return nodes[0] if nodes else "/dev/dri/renderD128"

def clean_stale(max_age=6 * 3600):
    """Work folders left behind by a crash (power loss, kill -9) are removed. Folders that were touched recently may belong to another running copy and stay."""
    n = 0
    for d in glob.glob(os.path.join(tempfile.gettempdir(), "spektronautilus-*")):
        try:
            if os.path.isdir(d) and not os.path.islink(d) and time.time() - os.path.getmtime(d) > max_age:
                shutil.rmtree(d, ignore_errors=True); n += 1
        except Exception: pass
    return n

# ------------------------------------------------------------------ Video2X (AI upscaling, optional, installed by the user)
def config_dir():
    base = os.environ.get("APPDATA") if WIN else os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    return Path(base or Path.home() / ".config") / APP_NAME

def v2x_find():
    """Video2X is a separate program (Linux: AppImage, AUR or your own build. Windows: the official release). We never ship it, we only start it if it is there.
    Looked for in: SPEKTRO_VIDEO2X, a one-line file video2x.txt in the settings folder, PATH and the usual places."""
    cands = [os.environ.get("SPEKTRO_VIDEO2X", "")]
    try: cands.append((config_dir() / "video2x.txt").read_text(encoding="utf-8", errors="replace").strip().strip('"'))
    except Exception: pass
    cands += [shutil.which("video2x") or "", str(Path.home() / ".local/bin/video2x")]
    pats = (r"%ProgramFiles%\Video2X*\video2x.exe", r"%ProgramFiles%\Video2X*\bin\video2x.exe", r"%ProgramFiles(x86)%\Video2X*\video2x.exe", r"%LocalAppData%\Programs\Video2X*\video2x.exe",
            r"~\Downloads\*ideo2*\video2x.exe", r"~\Video2X*\video2x.exe", r"C:\Video2X*\video2x.exe") if WIN else \
           ("~/Applications/*ideo2*", "~/Downloads/*ideo2*.AppImage", "~/.local/bin/*ideo2*.AppImage", "/opt/video2x/*")
    for pat in pats:
        cands += sorted(glob.glob(os.path.expandvars(os.path.expanduser(pat))), key=lambda x: -os.path.getmtime(x))
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK): return c
    return ""

def v2x_info():
    exe = v2x_find()
    if not exe: return {"ok": False, "why": "Video2X was not found", "conf": str(config_dir() / "video2x.txt")}
    ver, hlp = "", ""
    try:
        o = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=20, **NOWIN)
        ver = ((o.stdout or "") + (o.stderr or "")).strip().splitlines()[0][:60] if (o.stdout or o.stderr).strip() else ""
        h = subprocess.run([exe, "--help"], capture_output=True, text=True, timeout=20, **NOWIN); hlp = (h.stdout or "") + (h.stderr or "")
    except Exception:
        pass
    # versions differ: the graphics card is -g / --list-gpus in some and -d / --device / --list-devices in others. The help text tells which.
    return {"ok": True, "path": exe, "version": ver, "dev": "-d" if re.search(r"--device\b", hlp) and not re.search(r"--gpu\b", hlp) else "-g",
            "list": next((f for f in ("--list-devices", "--list-gpus", "--listgpus") if f in hlp), "--list-gpus"), "mul": "--frame-rate-mul" if "--frame-rate-mul" in hlp else "-m",
            "rife": bool(re.search(r"\brife\b", hlp, re.I)) if hlp else True, "conf": str(config_dir() / "video2x.txt")}


# Only these options (with values of the right shape) can reach Video2X. File names must stay inside the work folder.
V2X_FLAGS = {"-p": r"(realesrgan|libplacebo|rife)", "-d": r"\d{1,2}", "-m": r"[2-8]", "--frame-rate-mul": r"[2-8]", "-s": r"[2-4]", "-c": r"(libx264|libx265|libx264rgb)", "-e": r"(crf=\d{1,2}|preset=[a-z]+)", "-g": r"\d{1,2}",
             "--realesrgan-model": r"[\w.+-]{1,60}", "--rife-model": r"[\w.+-]{1,60}", "--libplacebo-shader": r"[\w.+-]{1,60}", "-w": r"\d{2,5}", "-h": r"\d{2,5}"}
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

SAFE_ARG = re.compile(r"^(?!/)(?!.*(^|[\\/])\.\.([\\/]|$))(?!.*:\/\/)(?!(file|pipe|http|https|tcp|udp|rtp|rtsp|concat|subfile|data|crypto|ftp|unix|async|cache|hls|md5)\s*:)(?!.*(movie=|subtitles=|fontfile|textfile|subfile|=/)).*$", re.S | re.I)   # no absolute paths, no .., no urls: ffmpeg may only touch the work folder
DUR = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
TIME = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")
secs = lambda m: int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])

class State:
    def __init__(self, docs, port):
        self.docs, self.port = docs, port
        self.work = Path(tempfile.mkdtemp(prefix="spektronautilus-"))
        self.ff = ffmpeg_info(); self.v2x = v2x_info(); self.procs = set(); self.lock = threading.Lock()
        if self.ff.get("ok"): threading.Thread(target=lambda: self.ff.update(hw=hw_probe(self.ff["path"])), daemon=True).start()     # a few seconds, so not while starting
        atexit.register(self.cleanup)
    def free_mb(self):
        try: return int(shutil.disk_usage(self.work).free / 1e6)
        except Exception: return None
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
            if self.path == "/api/native": return self._json({**self.st.ff, "v2x": self.st.v2x, "free_mb": self.st.free_mb()})
            if self.path == "/api/gpu": return self._json(gpu_stats())
            if self.path == "/api/sensors": return self._json(sensors())
            if self.path == "/api/v2x-gpus":
                if not self.st.v2x.get("ok"): return self._json({"ok": False, "why": self.st.v2x.get("why")})
                try:
                    o = subprocess.run([self.st.v2x["path"], self.st.v2x.get("list", "--list-gpus")], capture_output=True, text=True, timeout=40, cwd=self.st.work, **NOWIN)
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
        n = int(self.headers.get("Content-Length") or 0)
        fm = self.st.free_mb()
        if fm is not None and n / 1e6 + MIN_FREE_MB > fm: return self._deny(507, "Not enough free disk space")      # a full disk breaks ffmpeg half way through a long job
        p.parent.mkdir(parents=True, exist_ok=True)
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
            proc = subprocess.Popen([self.st.v2x["path"], *args], cwd=self.st.work, stdin=subprocess.DEVNULL, stderr=subprocess.STDOUT, stdout=subprocess.PIPE, **PRIO)
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
            proc = subprocess.Popen([self.st.ff["path"], "-nostdin", *args], cwd=self.st.work, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, **PRIO)
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
    if WIN:
        for c in WIN_BROWSERS:
            c = os.path.expandvars(c)
            if os.path.isfile(c): return c
    for b in BROWSERS:
        p = shutil.which(b)
        if p: return p
    if not WIN and shutil.which("flatpak"):          # Pop!_OS Shop installs browsers as Flatpak
        try: have = subprocess.run(["flatpak", "list", "--app", "--columns=application"], capture_output=True, text=True, timeout=10).stdout.split()
        except Exception: have = []
        for app in FLATPAK_BROWSERS:
            if app in have: return "flatpak:" + app
    return None

def open_default(url):
    try:
        if WIN: os.startfile(url)
        else: subprocess.Popen(["xdg-open", url])
    except Exception: print("Open this address yourself:", url)

def run_check():
    """spektronautilus --check : what works on this computer, in plain lines (send it along with a bug report)."""
    ok = lambda c: "OK     " if c else "MISSING"
    ff = ffmpeg_info(); print(f"{ok(ff.get('ok'))} ffmpeg " + (f"{ff['version']}, {ff['cores']} cores" if ff.get("ok") else ff.get("why", "")))
    if ff.get("ok"): hw = hw_probe(ff["path"]); print(f"{ok(hw)} graphics-card video encoding: " + (", ".join(hw) if hw else "none (normal software encoding is used)"))
    v = v2x_info(); print(f"{ok(v.get('ok'))} Video2X " + (v.get("path", "") if v.get("ok") else "(optional, for AI tools)"))
    vk = shutil.which("vulkaninfo")
    if vk:
        try: out = subprocess.run([vk, "--summary"], capture_output=True, text=True, timeout=20).stdout; names = sorted(set(re.findall(r"deviceName\s*=\s*(.+)", out)))
        except Exception: names = []
        print(f"{ok(names)} Vulkan (needed by the AI tools): " + (", ".join(names) if names else "no device found"))
    else: print("unknown Vulkan: install vulkan-tools to check (sudo apt install vulkan-tools)")
    g = gpu_stats(); print(("OK      NVIDIA " + ", ".join(f"{x['name']} {x['temp']} C" for x in g["gpus"])) if g.get("ok") else "-       no NVIDIA card (fine)")
    z = sensors(); print(f"{ok(z['ok'])} sensors: processor " + (f"{z['cpu_temp']} C" if z['cpu_temp'] is not None else "?") + (", on battery" if z["on_battery"] else ", on mains power" if z["on_battery"] is False else ""))
    b = find_browser(); print(f"{ok(b)} browser: {b or 'none found (the default browser is used)'}")
    try: print(f"OK      free disk for temporary files: {int(shutil.disk_usage(tempfile.gettempdir()).free / 1e6)} MB")
    except Exception: pass

def main():
    ap = argparse.ArgumentParser(description="Spektronautilus for Linux and Windows")
    ap.add_argument("--check", action="store_true", help="show what works on this computer and exit")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT); ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--window", action="store_true", help="normal browser window instead of an app window")
    ap.add_argument("--docs", help="folder with the website (default: next to this script)"); ap.add_argument("--path", default="", help="page to open, e.g. live-dj/")
    a = ap.parse_args()
    if a.check: return run_check()
    docs = Path(a.docs).resolve() if a.docs else find_docs()
    port = a.port
    if already_running(port):
        print(f"Spektronautilus is already running on port {port}. Opening a window for it.")
        if not a.no_browser: open_browser(port, a, docs)
        return
    if not port_free(port):
        print(f"Port {port} is busy, using a free one. (Your saved settings belong to port {port}, so close the other program if you can.)")
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    gone = clean_stale()
    st = State(docs, port); Handler.st = st
    handler = lambda *x, **k: Handler(*x, directory=str(docs), **k)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/{a.path}"
    print(f"Spektronautilus is running at {url}")
    print("AI upscaling with Video2X: " + (f"ON ({st.v2x['path']})" if st.v2x.get("ok") else "OFF (optional, see README-LINUX.txt)"))
    print("Fast converting with ffmpeg: " + (f"ON (ffmpeg {st.ff['version']}, {st.ff['cores']} cores)" if st.ff.get("ok") else f"OFF ({st.ff.get('why')}). Install ffmpeg to turn it on."))
    if gone: print(f"Removed {gone} old work folder(s) left by an earlier crash.")
    if st.free_mb() is not None and st.free_mb() < 5000: print(f"Careful: only {st.free_mb()} MB free on the disk used for temporary files. Long jobs may stop.")
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
        open_default(url)
        return None
    base = os.environ.get("APPDATA") if WIN else os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")
    prof = Path(base or Path.home() / ".config") / APP_NAME / "browser"
    pre = [b]
    if b.startswith("flatpak:"):          # the sandbox may only write inside its own folder
        app = b[8:]; prof = Path.home() / ".var/app" / app / "config" / APP_NAME / "browser"; pre = ["flatpak", "run", "--share=network", app]
    elif b.startswith("/snap/") or "/snap/bin/" in b:          # snap browsers may not write to hidden folders
        prof = Path.home() / "snap" / Path(b).name / "common" / (APP_NAME + "-browser")
    prof.mkdir(parents=True, exist_ok=True)
    cmd = [*pre, f"--user-data-dir={prof}", *CHROME_FLAGS, *EXTRA_FLAGS, *(["--new-window", url] if a.window else [f"--app={url}"])]
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    main()
