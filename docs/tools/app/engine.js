// The video engine: ffmpeg compiled to WebAssembly, running in a worker inside the page.
// The app only talks to this small interface, so the engine can be swapped (the tests plug in a native ffmpeg).
//
//   engine.load(onStatus)              start the engine (downloads ffmpeg-core.wasm the first time)
//   engine.exec(args, {onProgress})    run ffmpeg -> { code, log }       (all paths are relative to the engine's own file system)
//   engine.write(path, uint8)          put a file in the engine
//   engine.read(path)                  get a file out -> Uint8Array
//   engine.remove(path)                delete a file
//   engine.mount(file) / unmount(p)    let ffmpeg read a File from disk without copying it into memory
//   engine.terminate()                 stop at once (used by "Stop"); the next call starts it again

const VENDOR = new URL('./vendor/', import.meta.url);

export class WasmEngine {
  constructor() { this.ff = null; this.cur = null; this.mounts = 0; this.loading = null; }

  async load(onStatus = () => {}) {
    if (this.ff) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      onStatus('Loading the video engine (about 30 MB, only the first time)…');
      let mod;
      try { mod = await import(new URL('ffmpeg/index.js', VENDOR).href); }
      catch (e) {
        throw new Error('The video engine files are missing. Run  python3 get-ffmpeg.py  in the repository once (it downloads ffmpeg.wasm into docs/tools/vendor), then reload this page. (Using the Linux version? Install ffmpeg instead, for example  sudo apt install ffmpeg , and start Spektronautilus again.)');
      }
      const ff = new mod.FFmpeg();
      ff.on('log', ({ message }) => { if (this.cur) this.cur.log.push(message); });
      ff.on('progress', ({ progress }) => { if (this.cur && this.cur.onProgress && progress >= 0 && progress <= 1) this.cur.onProgress(progress); });
      await ff.load({ coreURL: new URL('core/ffmpeg-core.js', VENDOR).href, wasmURL: new URL('core/ffmpeg-core.wasm', VENDOR).href });
      this.ff = ff;
    })();
    try { await this.loading; } finally { this.loading = null; }
  }

  async exec(args, { onProgress } = {}) {
    await this.load();
    this.cur = { log: [], onProgress };
    let code;
    try { code = await this.ff.exec(args); }
    finally { var log = this.cur.log; this.cur = null; }
    return { code, log };
  }
  async write(path, data) { await this.load(); await this.ff.writeFile(path, data); }
  async read(path) { await this.load(); return await this.ff.readFile(path); }
  async remove(path) { try { await this.ff.deleteFile(path); } catch (e) { /* already gone */ } }

  async mount(file) {
    await this.load();
    const dir = `m${++this.mounts}`;
    await this.ff.createDir('/' + dir);
    await this.ff.mount('WORKERFS', { files: [file] }, '/' + dir);
    return `${dir}/${file.name}`;
  }
  async unmount(path) {
    const dir = path.split('/')[0];
    try { await this.ff.unmount('/' + dir); await this.ff.deleteDir('/' + dir); } catch (e) { /* ignore */ }
  }
  terminate() { try { this.ff && this.ff.terminate(); } catch (e) { /* ignore */ } this.ff = null; this.cur = null; }
}

// The local (Linux) version of Spektronautilus runs a small server on this computer that has the real ffmpeg.
// It is much faster than the WebAssembly one and has no memory limit. On the web the server does not exist and the wasm engine is used.
export class NativeEngine {
  constructor(info) { this.info = info; this.kind = 'native'; this.mounts = 0; }
  async load() {}
  async _put(path, body) { const r = await fetch('/api/fs/' + encodeURI(path), { method: 'PUT', headers: { 'X-Spk': '1' }, body }); if (!r.ok) throw new Error('The local engine could not store a file (' + r.status + ').'); }
  async exec(args, { onProgress } = {}) {
    const r = await fetch('/api/exec', { method: 'POST', headers: { 'X-Spk': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    if (!r.ok || !r.body) throw new Error('The local engine did not start (' + r.status + ').');
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '', out = null;
    for (;;) {
      const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line) continue; const m = JSON.parse(line); if (m.p != null) onProgress && onProgress(m.p); else out = m; }
    }
    if (!out) throw new Error('The local engine stopped. If you pressed Stop this is normal.');
    return { code: out.code, log: out.log };
  }
  async write(path, data) { await this._put(path, data); }
  async read(path) { const r = await fetch('/api/fs/' + encodeURI(path), { headers: { 'X-Spk': '1' } }); if (!r.ok) throw new Error('Could not read ' + path + ' from the local engine.'); return new Uint8Array(await r.arrayBuffer()); }
  async remove(path) { try { await fetch('/api/fs/' + encodeURI(path), { method: 'DELETE', headers: { 'X-Spk': '1' } }); } catch (e) { /* ignore */ } }
  async mount(file) { const p = `m${++this.mounts}/${file.name}`; await this._put(p, file); return p; }        // the File is streamed from disk, not read into memory
  async unmount(path) { await this.remove(path.split('/')[0]); }
  terminate() { try { fetch('/api/kill', { method: 'POST', headers: { 'X-Spk': '1' }, keepalive: true }); } catch (e) { /* ignore */ } }
}

// Picks the native engine when the local server offers one, otherwise the WebAssembly engine.
class AutoEngine {
  constructor() { this.impl = null; this.kind = ''; this.picking = null; }
  async pick() {
    if (this.impl) return this.impl;
    this.picking = this.picking || (async () => {
      let info = null;
      try { const r = await fetch('/api/native', { headers: { 'X-Spk': '1' } }); if (r.ok) { const j = await r.json(); if (j && j.ok) info = j; } } catch (e) { /* not the local version */ }
      this.impl = info ? new NativeEngine(info) : new WasmEngine(); this.kind = info ? 'native' : 'wasm'; this.info = info;
    })();
    await this.picking; return this.impl;
  }
  async load(onStatus) { const e = await this.pick(); return e.load(onStatus); }
  async exec(a, o) { return (await this.pick()).exec(a, o); }
  async write(p, d) { return (await this.pick()).write(p, d); }
  async read(p) { return (await this.pick()).read(p); }
  async remove(p) { return (await this.pick()).remove(p); }
  async mount(f) { return (await this.pick()).mount(f); }
  async unmount(p) { return (await this.pick()).unmount(p); }
  terminate() { this.impl && this.impl.terminate(); }
}

export function getEngine() { return window.__VJ_ENGINE__ || new AutoEngine(); }
