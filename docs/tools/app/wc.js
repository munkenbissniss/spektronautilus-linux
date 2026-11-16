// The fast path for the Loop Hospital in the browser: the device's own video chip reads and writes the video (WebCodecs), and the
// graphics card does all the picture work (gpu.js), including Smooth motion. Frames stream through one at a time, so even a big clip
// needs little memory, and ffmpeg (30 MB, slow on a phone) is not needed at all. Treatments it cannot do yet (the Looks, keeping the
// sound, AI) and files it cannot read (GIFs, other containers, codecs the device does not have) go the ffmpeg way as before.
//
// The work is done in passes, like the ffmpeg way: [Smooth out] -> [Frame rate] -> main (cut, turn, crop, slow motion, Life, Ken Burns,
// upscale, size) -> [Make it loop]. Passes in between are kept in memory as compact, near lossless video. A result that is repeated to a
// minimum length is encoded once and the encoded frames are copied, when nothing changes from one round to the next.
import { demux, sampleData, muxMp4, fpsRational } from './mp4.js';
import { Gpu } from './gpu.js';
import { chooseFps, repeatsNeeded, cropFor, targetSize, maxMBps, codecArgs } from './core.js';
import { analyzeFrames, reportText, loopForecast } from './loops.js';
import * as ST from './steps.js';

const TEST = () => (typeof window !== 'undefined' && window.SPK_WC_TEST) || null;   // tests: { codec: 'vp09...' } where H.264 is missing
const EXT = /\.(mp4|m4v|mov)$/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// where the time goes (seconds): reading frames (incl. upload), handing frames to the graphics card, picture work, writing
export const TIMES = { read: 0, upload: 0, picture: 0, write: 0, starts: 0 };   // starts: how often a decoder had to begin again from a key frame
const now = () => performance.now();

// (tests can force the plain way of reading pictures back; so can localStorage.spk_read = 'plain', should a graphics driver misbehave)
const newGpu = () => { const x = TEST(); if (x && x.syncRead != null) Gpu.syncRead = x.syncRead; else { try { if (localStorage.getItem('spk_read') === 'plain') Gpu.syncRead = true; } catch (e) { /* no storage */ } } return new Gpu(); };
// ---------------------------------------------------------------------------------------------- can this browser do it?
const avcLevels = [['640028', 245760, 8192], ['64002A', 522240, 8704], ['640032', 589824, 22080], ['640033', 983040, 36864], ['640034', 2073600, 36864]];
function avcCandidates(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16), rate = mbs * fps, out = [];
  for (const [c, r, f] of avcLevels) if (rate <= r && mbs <= f) out.push('avc1.' + c);
  out.push('avc1.640034', 'avc1.4d0034', 'avc1.42e034'); return [...new Set(out)];
}
// the codec to write with, for this size; null when the device cannot
export async function encoderFor(w, h, fps, bitrate) {
  const t = TEST(), cands = t && t.codec ? [t.codec] : avcCandidates(w, h, fps);
  for (const codec of cands) {
    const cfg = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable', ...(codec.startsWith('avc') ? { avc: { format: 'avc' } } : {}) };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return { cfg: s.config || cfg, mux: codec.startsWith('avc') ? 'avc' : 'vp9' }; } catch (e) { /* next */ }
  }
  return null;
}
let SUP = null, GPU_INFO = { renderer: '', software: false };
// { renderer, software }: software = the browser draws without the graphics card (known after supported())
export const gpuInfo = () => GPU_INFO;
export function supported() {
  return SUP || (SUP = (async () => {
    try {
      if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined' || typeof EncodedVideoChunk === 'undefined' || !window.isSecureContext) return false;
      if (typeof localStorage !== 'undefined') { try { if (localStorage.getItem('spk_wc') === 'off') return false; } catch (e) { /* ignore */ } }
      const g = newGpu(); GPU_INFO = { renderer: g.renderer, software: g.software && !(TEST() && TEST().allowSoftware !== false) }; g.destroy();
      return !!(await encoderFor(1280, 720, 30, 5e6));
    } catch (e) { return false; }
  })());
}

// ---------------------------------------------------------------------------------------------- opening a clip
// A handle for a file the fast path can read: { file, dm, info } (info in the same shape as the ffmpeg probe), or null.
export async function open(file) {
  if (!EXT.test(file.name || '') || !(await supported())) return null;
  let dm; try { dm = await demux(file); } catch (e) { return null; }
  const v = dm.video; if (!v.codec || !v.count || !(v.duration > 0)) return null;
  const cfg = { codec: v.codec, codedWidth: v.codedWidth, codedHeight: v.codedHeight, ...(v.description ? { description: v.description } : {}) };
  try { const s = await VideoDecoder.isConfigSupported(cfg); if (!s.supported) return null; } catch (e) { return null; }
  const info = { name: file.name, width: v.width, height: v.height, codec: v.name, pix_fmt: '', fps: v.fps, duration: v.duration, hasAudio: dm.hasAudio, rotation: v.rotation,
    isGif: false, alpha: false, frames: v.count };
  return { file, dm, cfg, info, grays: null };
}

// Can the fast path do this recipe? Everything except the Looks, keeping the sound and the AI methods.
export function canRun(h, R) {
  if (!h) return false;
  if (R.look && R.look.on) return false;
  if (R.out && R.out.keepAudio && h.info.hasAudio && !(R.slow && R.slow.on) && !(R.smooth && R.smooth.on)) return false;
  if (ST.wantsAi(R)) return false;
  if (R.up && R.up.on && R.up.engine !== 'sharp') return false;
  return true;
}

// ---------------------------------------------------------------------------------------------- reading frames
// Frames in display order 0..n-1, as textures. Asking for frames in order is cheap; going back starts again from the key frame before.
// The decoder is only fed a few frames ahead of the one asked for. A fast decoder would otherwise run far ahead, its frames would push
// the needed ones out of the small cache, and every frame would mean decoding again from the last key frame (very slow on clips with
// few key frames). A decoder that keeps some frames to itself gets one more whenever it has nothing left to do.
class Source {
  constructor(h, gpu, { cache = 6, mips = false } = {}) {
    this.h = h; this.v = h.dm.video; this.gpu = gpu; this.max = Math.max(4, cache); this.look = this.max - 3; this.mips = mips; this.n = this.v.count;
    this.inv = new Int32Array(this.n); this.v.order.forEach((s, k) => { this.inv[s] = k; });
    this.ts = new Map(); for (let k = 0; k < this.n; k++) this.ts.set(Math.round(this.v.pts[k] * 1e6), k);
    this.cache = new Map(); this.spare = []; this.want = 0; this.back = false; this.pins = new Set(); this._p = null; this._r = null;
    this.dec = null; this.err = null; this.fed = 0; this.fedFrom = 0; this.maxOut = -1; this.flushP = null; this.flushed = false;
    this.seen = new Uint8Array(this.n);   // frames the current decoder has given (kept or not)
    this.buf = null; this.tFeed = 0; this.tOut = 0; this.starts = 0;
  }
  wake() { const r = this._r; this._r = null; this._p = null; if (r) r(); }
  signal() { return this._p || (this._p = new Promise(r => { this._r = r; })); }
  start(d) {
    const old = this.dec; this.dec = null; if (old) { try { old.close(); } catch (e) { /* closed */ } }
    this.err = null; this.flushP = null; this.flushed = false; this.maxOut = -1; this.fed = d; this.fedFrom = d; this.buf = null; this.seen.fill(0); this.tFeed = this.tOut = now(); this.starts++; TIMES.starts++;
    // a decoder that was replaced still reports (its own close is an "abort"): only the current one counts
    const dec = this.dec = new VideoDecoder({ output: f => { if (this.dec === dec) this.got(f); else f.close(); }, error: e => { if (this.dec === dec) { this.err = e; this.wake(); } } });
    dec.configure(this.h.cfg); if ('ondequeue' in dec) dec.ondequeue = () => this.wake();
  }
  got(f) {
    const k = this.ts.get(Math.round(f.timestamp));
    try {
      if (k === undefined) return;
      this.seen[k] = 1; this.tOut = now(); if (k > this.maxOut) this.maxOut = k;
      if (this.cache.has(k)) return;
      if (k < this.want - (this.back ? this.max - 3 : 1) && !this.pins.has(k)) return;   // behind what is needed: not kept (going backwards: a window is kept)
      this.put(k, f);
    } finally { f.close(); this.wake(); }
  }
  // how little a cached frame is worth now: far behind (or, going backwards, far ahead) is worst
  bad(kk) { const w = this.want; return this.back ? (kk > w + 1 ? 1000 + kk - w : w - kk) : (kk < w - 1 ? 1000 + w - kk : kk - w); }
  put(k, f) {
    if (this.cache.size >= this.max) {
      const must = this.pins.has(k) || k === this.want;
      let worst = null, wb = must ? -1 : this.bad(k);   // the new frame competes too, unless it is the one asked for
      for (const kk of this.cache.keys()) if (!this.pins.has(kk) && kk !== this.want) { const b = this.bad(kk); if (b > wb) { wb = b; worst = kk; } }
      if (worst === null && !must) return;              // the new frame is the least useful one: not kept
      if (worst !== null) { this.spare.push({ t: this.cache.get(worst), at: this.gpu.issued }); this.cache.delete(worst); }
    }
    // A texture is only used again when the graphics card has finished everything that was asked of it while the old frame was in it
    // (pictures are read back without waiting, see gpu.readBegin; an upload must not overtake a drawing that still needs the old frame).
    let into = null; for (let i = 0; i < this.spare.length; i++) if (this.spare[i].at <= this.gpu.done) { into = this.spare.splice(i, 1)[0].t; break; }
    const t0 = now(), t = this.gpu.upload(f, f.displayWidth, f.displayHeight, this.mips, into); TIMES.upload += (now() - t0) / 1000;
    this.cache.set(k, t);
    while (this.spare.length > 6) { const i = this.spare.findIndex(x => x.at <= this.gpu.done); if (i < 0) break; this.gpu.free(this.spare.splice(i, 1)[0].t); }
  }
  async read(s) {   // the bytes of sample s, read ahead in blocks
    const v = this.v, b = this.buf;
    if (b && s >= b.s0 && s < b.s1) return b.data.subarray(v.offsets[s] - b.o0, v.offsets[s] - b.o0 + v.sizes[s]);
    let s1 = s + 1; const o0 = v.offsets[s]; let end = o0 + v.sizes[s];
    while (s1 < v.count && s1 < s + 64 && v.offsets[s1] >= end - 1 && v.offsets[s1] + v.sizes[s1] - o0 < 8e6 && v.offsets[s1] - end < 65536) { end = v.offsets[s1] + v.sizes[s1]; s1++; }
    const data = new Uint8Array(await this.h.file.slice(o0, end).arrayBuffer());
    this.buf = { s0: s, s1, o0, data };
    return data.subarray(0, v.sizes[s]);
  }
  async feed() {
    const dec = this.dec, s = this.fed++, v = this.v, k = this.inv[s], data = await this.read(s); this.tFeed = now();
    if (dec !== this.dec) return;   // replaced while the bytes were read
    dec.decode(new EncodedVideoChunk({ type: v.key[s] ? 'key' : 'delta', timestamp: Math.round(v.pts[k] * 1e6), duration: Math.round(1e6 / (v.fps || 30)), data }));
  }
  keyBefore(k) { const v = this.v; for (let s = this.inv[k]; s >= 0; s--) if (v.key[s] && this.inv[s] <= k) return s; return 0; }
  async get(k, pin = []) {
    k = Math.max(0, Math.min(this.n - 1, k)); if (k < this.want - 1) this.back = true; else if (k > this.want + 1) this.back = false; this.want = k; this.pins = new Set(pin);
    let hit = this.cache.get(k); if (hit) return hit;
    const s = this.inv[k];
    // given already and not kept, or before where this decoder began, or the decoder was emptied: again from the key frame before it
    if (!this.dec || s < this.fedFrom || this.seen[k] || this.flushed) this.start(this.keyBefore(k));
    else if (s - this.fed > 90) { const d = this.keyBefore(k); if (d > this.fed) this.start(d); }
    let last = now(), mark = '', again = 0;
    for (;;) {
      hit = this.cache.get(k); if (hit) return hit;
      if (this.err) throw new Error('DECODE: ' + (this.err.message || this.err));
      if (this.seen[k] && !this.flushed) { if (++again > 3) throw new Error('DECODE: frame ' + k + ' was lost'); this.start(this.keyBefore(k)); continue; }
      if (this.flushed) {   // the decoder gave all it had: the nearest frame it did give
        let best = null, bd = 1e9; for (const [kk, t] of this.cache) if (Math.abs(kk - k) < bd) { bd = Math.abs(kk - k); best = t; }
        if (best) return best; throw new Error('DECODE: frame ' + k + ' missing');
      }
      const st = this.maxOut + ':' + this.fed; if (st !== mark) { mark = st; last = now(); }
      else if (now() - last > 20000 && document.visibilityState !== 'hidden') throw new Error('DECODE: the video chip stopped answering');
      const sig = this.signal(), q = this.dec.decodeQueueSize;
      // a few frames ahead of the one asked for; one more when the decoder has nothing to do and still holds the frame back
      const idle = q === 0 && now() - this.tFeed > 12 && now() - this.tOut > 12;
      if (this.fed < this.n && q < 4 && (this.fed <= s + this.look || idle)) { await this.feed(); continue; }
      if (this.fed >= this.n && !this.flushP) { const dec = this.dec; this.flushP = dec.flush().then(() => { if (this.dec === dec) { this.flushed = true; this.wake(); } }, e => { if (this.dec === dec) { this.err = e; this.wake(); } }); }
      await Promise.race([sig, sleep(q === 0 ? 6 : 40)]);
    }
  }
  close() { const d = this.dec; this.dec = null; if (d) { try { d.close(); } catch (e) { /* closed */ } } for (const t of this.cache.values()) this.gpu.free(t); for (const x of this.spare) this.gpu.free(x.t); this.cache.clear(); this.spare = []; }
}

// ---------------------------------------------------------------------------------------------- writing frames
const bpp = crf => 0.1 * Math.pow(2, (18 - crf) / 6);   // bits per pixel per frame that roughly match x264's quality setting
class Encoder {
  constructor(w, h, fps, { crf = 18, gop = 30, inter = false, cap = 0 } = {}) {
    this.w = w; this.h = h; this.fps = fps; this.gop = Math.max(1, Math.round(gop)); this.chunks = []; this.desc = null; this.err = null; this.ts = new Map();
    let br = w * h * fps * (inter ? 0.28 : bpp(crf)); br = Math.max(inter ? 4e6 : 6e5, br); if (cap > 0) br = Math.min(br, cap); if (inter) br = Math.min(br, 80e6);
    this.bitrate = Math.round(br);
  }
  async init() {
    const e = await encoderFor(this.w, this.h, this.fps, this.bitrate);
    if (!e) throw new Error('ENCODE: this device cannot write ' + this.w + '×' + this.h);
    this.mux = e.mux;
    this.enc = new VideoEncoder({ output: (c, meta) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); if (meta && meta.decoderConfig && meta.decoderConfig.description) this.desc = new Uint8Array(meta.decoderConfig.description instanceof ArrayBuffer ? meta.decoderConfig.description : meta.decoderConfig.description.buffer.slice(meta.decoderConfig.description.byteOffset, meta.decoderConfig.description.byteOffset + meta.decoderConfig.description.byteLength)); this.chunks.push({ data: d, key: c.type === 'key', pts: this.ts.get(c.timestamp) ?? Math.round(c.timestamp * this.fps / 1e6) }); },
      error: e => { this.err = e; } });
    this.enc.configure(e.cfg);
    return this;
  }
  async add(pic, n) {   // pic: from gpu.i420()
    if (this.err) throw new Error('ENCODE: ' + (this.err.message || this.err));
    while (this.enc.encodeQueueSize > 4) { await sleep(2); if (this.err) throw new Error('ENCODE: ' + (this.err.message || this.err)); }
    const ts = Math.round(n * 1e6 / this.fps); this.ts.set(ts, n);
    const f = new VideoFrame(pic.data, { format: 'I420', codedWidth: pic.w, codedHeight: pic.h, timestamp: ts, duration: Math.round(1e6 / this.fps), layout: pic.layout,
      colorSpace: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', fullRange: false } });
    try { this.enc.encode(f, { keyFrame: n % this.gop === 0 }); } finally { f.close(); }
  }
  async finish() {
    const tw = now(); await this.enc.flush(); TIMES.write += (now() - tw) / 1000; if (this.err) throw new Error('ENCODE: ' + (this.err.message || this.err)); try { this.enc.close(); } catch (e) { /* closed */ }
    return { chunks: this.chunks, desc: this.desc, mux: this.mux, w: this.w, h: this.h, fps: this.fps };
  }
  close() { try { this.enc && this.enc.state !== 'closed' && this.enc.close(); } catch (e) { /* closed */ } }
}
// The local Linux version: the frames go to the computer's own ffmpeg (x264 on all processor cores) instead of the browser's encoder,
// which on Linux is a slow software one. Same interface as Encoder; the finished video comes back as encoded frames.
let NE = 0;
const nativeArgs = (inter, prof, crf, gop) => {
  const t = TEST(), ta = t && t.nativeArgs && t.nativeArgs(inter); if (ta) return ta;
  if (inter) return ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '14', '-bf', '0', '-g', String(gop), '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  return [...codecArgs({ ...prof, crf, gop, preset: 'veryfast' }), '-color_range', 'tv'];
};
class NativeEncoder {
  constructor(eng, w, h, fps, { crf = 18, gop = 30, inter = false, prof = {} } = {}) { Object.assign(this, { eng, w, h, fps, crf, gop: Math.max(1, Math.round(gop)), inter, prof, n: 0, prev: null, id: null, done: false }); }
  async init() {
    const { ts, dur } = fpsRational(this.fps); this.out = `wc_enc_${Date.now().toString(36)}_${++NE}.mp4`;
    this.id = await this.eng.encOpen({ w: this.w, h: this.h, fps: `${ts}/${dur}`, out: this.out, args: nativeArgs(this.inter, this.prof, this.crf, this.gop) });
    return this;
  }
  err(e) { return Object.assign(new Error('ENCODE: ' + (e && e.message || e)), { nativeEnc: true }); }
  async add(pic) {   // one frame is on its way while the next is being made
    const p = this.prev; this.prev = null; if (p) { try { await p; } catch (e) { throw this.err(e); } }
    const q = this.eng.encFrame(this.id, pic.data.subarray(0, pic.w * pic.h * 3 / 2)); q.catch(() => {}); this.prev = q; this.n++;
  }
  async finish() {
    const tw = now(); let u8, v;
    try {
      if (this.prev) await this.prev;
      const r = await this.eng.encClose(this.id); this.done = true;
      if (r.code !== 0) throw new Error('the local encoder failed (' + ((r.log || []).filter(l => /error|invalid|unknown|no such|not /i.test(l)).slice(-1)[0] || 'code ' + r.code).slice(0, 160) + ')');
      u8 = await this.eng.read(this.out); await this.eng.remove(this.out);
      v = (await demux(new File([u8], 'enc.mp4'))).video;
      if (v.count !== this.n) throw new Error(`the local encoder wrote ${v.count} of ${this.n} frames`);
    } catch (e) { throw this.err(e); }
    const inv = new Int32Array(v.count); v.order.forEach((s, k) => { inv[s] = k; });
    const chunks = []; for (let s = 0; s < v.count; s++) chunks.push({ data: u8.subarray(v.offsets[s], v.offsets[s] + v.sizes[s]), key: !!v.key[s], pts: inv[s] });
    TIMES.write += (now() - tw) / 1000;
    return { chunks, desc: v.description, mux: /^avc/.test(v.fmt) ? 'avc' : 'vp9', w: this.w, h: this.h, fps: this.fps };
  }
  close() { if (this.id != null && !this.done) { this.done = true; this.eng.encClose(this.id, true).catch(() => {}); try { this.eng.remove(this.out); } catch (e) { /* ignore */ } } }
}
const toMp4 = (r, repeat = 1) => {
  let chunks = r.chunks;
  if (repeat > 1) { const per = chunks.length; chunks = []; for (let i = 0; i < repeat; i++) for (const c of r.chunks) chunks.push({ ...c, pts: c.pts + i * per }); }
  return muxMp4({ codec: r.mux, width: r.w, height: r.h, description: r.desc, fps: r.fps, chunks });
};
// a pass result kept in memory, opened again as a clip
async function reopen(r) {
  const file = new File([toMp4(r)], 'pass.mp4', { type: 'video/mp4' }), dm = await demux(file), v = dm.video;
  return { file, dm, cfg: { codec: v.codec, codedWidth: v.codedWidth, codedHeight: v.codedHeight, ...(v.description ? { description: v.description } : {}) },
    info: { width: v.width, height: v.height, fps: r.fps, duration: v.count / r.fps, frames: v.count } };
}

// ---------------------------------------------------------------------------------------------- 3 x 3 matrices (row-major)
const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul = (a, b) => { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; return o; };
const tr = (x, y) => [1, 0, x, 0, 1, y, 0, 0, 1], sc = (x, y) => [x, 0, 0, 0, y, 0, 0, 0, 1];
// output corners (0,0) (W,0) (0,H) (W,H) -> the four points ffmpeg's perspective filter is given (sense=source)
function quad(W, H, q) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;   // (0,0) (W,0) (0,H) (W,H)
  const sx = x0 - x1 + x3 - x2, sy = y0 - y1 + y3 - y2;
  let a, b, c, d, e, f, g = 0, h = 0;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) { a = x1 - x0; b = x2 - x0; c = x0; d = y1 - y0; e = y2 - y0; f = y0; }
  else {
    const dx1 = x1 - x3, dx2 = x2 - x3, dy1 = y1 - y3, dy2 = y2 - y3, den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den;
    a = x1 - x0 + g * x1; b = x2 - x0 + h * x2; c = x0; d = y1 - y0 + g * y1; e = y2 - y0 + h * y2; f = y0;
  }
  return mul([a, b, c, d, e, f, g, h, 1], sc(1 / W, 1 / H));
}
const persp = (W, H, m) => { const hw = W / (2 * m.S), hh = H / (2 * m.S), t = m.t || 0, { cx, cy } = m;
  return quad(W, H, [cx - hw + hh * t, cy - hw * t - hh, cx + hw + hh * t, cy + hw * t - hh, cx - hw - hh * t, cy - hw * t + hh, cx + hw - hh * t, cy + hw * t + hh]); };
// display picture -> the decoded picture (iPhone portrait clips are stored wide and turned by a matrix)
function dispToCoded(v) {
  const M = v.matrix, det = M.a * M.d - M.b * M.c; if (!det) return I3();
  const ia = M.d / det, ib = -M.c / det, ic = -M.b / det, id = M.a / det;   // inverse of [a c; b d]
  return mul([ia, ib, 0, ic, id, 0, 0, 0, 1], tr(-M.tx, -M.ty));
}
// rotatePlan as a matrix: turned picture pixel -> picture pixel (w, h = before turning)
function rotM(w, h, { turn = '0', flip = 'none' } = {}) {
  const t = String(turn), sw = t === '90' || t === '270', W = sw ? h : w, H = sw ? w : h;
  let m = t === '90' ? [0, 1, 0, -1, 0, h, 0, 0, 1] : t === '270' ? [0, -1, w, 1, 0, 0, 0, 0, 1] : t === '180' ? [-1, 0, w, 0, -1, h, 0, 0, 1] : I3();
  if (flip === 'h') m = mul(m, [-1, 0, W, 0, 1, 0, 0, 0, 1]); else if (flip === 'v') m = mul(m, [1, 0, 0, 0, -1, H, 0, 0, 1]);
  return { m, w: W, h: H };
}
// the size box: target pixel -> picture pixel, and the clip for letterbox bars
function sizeM(w, h, tw, th, fit) {
  if (fit === 'fill') { const s = Math.max(tw / w, th / h); return { m: mul(sc(1 / s, 1 / s), tr((w * s - tw) / 2, (h * s - th) / 2)), clip: null }; }
  if (fit === 'fit') { const s = Math.min(tw / w, th / h), m = mul(sc(1 / s, 1 / s), tr(-(tw - w * s) / 2, -(th - h * s) / 2)); return { m, clip: { C: m, w, h } }; }
  return { m: sc(w / tw, h / th), clip: null };
}

// ---------------------------------------------------------------------------------------------- one pass
// at(n) -> { layers: [{ a, b, w, mode, alpha }], H, clip, sharp, bright, sat, trails }   (a, b: input frame numbers; w: 0..1 towards b)
const isIdent = H => H[0] === 1 && H[1] === 0 && H[2] === 0 && H[3] === 0 && H[4] === 1 && H[5] === 0 && H[6] === 0 && H[7] === 0 && H[8] === 1;
async function pass(gpu, src, { w, h, count, at, enc, gray = false, ctl, report, tag }) {
  const grays = gray ? new Uint8Array(count * 64 * 36) : null, hist = [], big = src.mips;
  // one layer of the frame as a texture of the output size: the input frame itself when nothing has to be moved or scaled
  const layer = async (L, name) => {
    const pin = [L.a, L.b].filter(x => x != null);
    let tr = now(); const A = await src.get(L.a, pin); TIMES.read += (now() - tr) / 1000;
    let T = A, lent = true;   // lent: a texture of the frame reader, which may reuse it for another frame later
    if (L.b != null && L.b !== L.a && L.w > 1e-4 && L.w < 1 - 1e-4) {
      tr = now(); const B = await src.get(L.b, pin), A2 = src.cache.get(L.a) || await src.get(L.a, pin); TIMES.read += (now() - tr) / 1000;
      T = gpu.tmp(`${tag}mx${name}`, A2.w, A2.h, 'rgba8', big); lent = false;
      if (L.mode === 'motion') gpu.interp(T, A2, B, L.w, `${tag}:${L.a}:${L.b}`); else gpu.mix(T, A2, B, L.w);
      gpu.mipmap(T);
    } else if (L.b != null && L.w >= 1 - 1e-4) { tr = now(); T = await src.get(L.b, pin); TIMES.read += (now() - tr) / 1000; }
    if (isIdent(L.H) && !L.clip && T.w === w && T.h === h) return { t: T, lent };
    const out = gpu.tmp(`${tag}${name}`, w, h); gpu.warp(out, T, L.H, { clip: L.clip }); return { t: out, lent: false };
  };
  // the finished frame goes to the encoder one step behind: while the graphics card finishes frame n, the page already prepares n + 1
  let pend = null;
  const deliver = async j => {
    const tp = now(), r = await gpu.readEnd(j.job); TIMES.picture += (now() - tp) / 1000;
    if (grays) grays.set(r.gray, j.n * 2304);
    const tw = now(); await enc.add(r.pic, j.n); TIMES.write += (now() - tw) / 1000;
    if (report && (j.n % 4 === 0 || j.n === count - 1)) report((j.n + 1) / count);
  };
  for (let n = 0; n < count; n++) {
    ctl.check(); gpu.check();
    const d = at(n);
    const l1 = await layer({ ...d.layers[0], H: d.H, clip: d.clip }, 'o1'); let cur = l1.t;
    if (d.layers[1]) {
      // a lent first layer could be reused while the second layer's frame is read: keep a copy of it first
      if (l1.lent) { const c = gpu.tmp(`${tag}o1c`, w, h); gpu.mix(c, cur, cur, 0); cur = c; }
      const l2 = await layer({ ...d.layers[1], H: d.H, clip: d.clip }, 'o2'), o3 = gpu.tmp(`${tag}o3`, w, h); gpu.mix(o3, cur, l2.t, d.layers[1].alpha); cur = o3;
    }
    const tq = now();
    if (d.sharp > 0 || d.bright || (d.sat != null && d.sat !== 1)) { const f = gpu.tmp(`${tag}fx`, w, h); gpu.fx(f, cur, { sharp: d.sharp || 0, bright: d.bright || 0, sat: d.sat == null ? 1 : d.sat }); cur = f; }
    if (d.trails) {   // ffmpeg tmix=frames=4:weights='4 3 2 1' (the oldest frame weighs most)
      const slot = gpu.tmp(`${tag}h${n % 4}`, w, h); gpu.mix(slot, cur, cur, 0); hist.push(slot); if (hist.length > 4) hist.shift();
      const ws = [4, 3, 2, 1].slice(0, hist.length); const t = gpu.tmp(`${tag}tr`, w, h); gpu.trail(t, hist, ws); cur = t;
    }
    const job = gpu.readBegin(cur, !!grays); TIMES.picture += (now() - tq) / 1000;
    if (!gpu.asyncRead) await deliver({ job, n });
    else { if (pend) await deliver(pend); pend = { job, n }; }
  }
  if (pend) await deliver(pend);
  return { grays };
}

// frame lookup on an input of n frames at fps F: the frames around time t (seconds) and how far between them
const around = (n, F, t) => { const x = Math.max(0, Math.min(n - 1, t * F)), a = Math.floor(x); return { a, b: Math.min(n - 1, a + 1), w: Math.min(1, x - a) }; };
const mdiff = (d, a, b) => { let s = 0; const oa = a * 2304, ob = b * 2304; for (let i = 0; i < 2304; i++) s += Math.abs(d[oa + i] - d[ob + i]); return s / 2304 / 255; };

// ---------------------------------------------------------------------------------------------- studying a clip
// The small grey pictures of every frame (for the loop check, Smooth out and Frame rate), worked out once per clip.
export async function grays(h, ctl, report) {
  if (h.grays) return h.grays;
  const gpu = newGpu(), src = new Source(h, gpu, { cache: 3 }), n = src.n, data = new Uint8Array(n * 2304);
  try { for (let k = 0; k < n; k++) { if (ctl) ctl.check(); const t = await src.get(k); data.set(gpu.gray(t), k * 2304); if (report && k % 8 === 0) report(k / n); } }
  finally { src.close(); gpu.destroy(); }
  return (h.grays = { data, n });
}
export async function analyze(h) { const g = await grays(h); return (h.loopRep = analyzeFrames(g.data, g.n, chooseFps(h.info, { fps: 0, maxFps: 60 }))); }

// ---------------------------------------------------------------------------------------------- the recipe
// Returns { data (an mp4 file), note }. Same order and the same numbers as runRecipe in steps.js.
export async function run(h, R, baseProf, { ctl = { check() {} }, onProgress, native = null } = {}) {
  for (const k of Object.keys(TIMES)) TIMES[k] = 0;
  let hidden = false; const vis = () => { if (document.visibilityState === 'hidden') hidden = true; };
  document.addEventListener('visibilitychange', vis);
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await runOnce(h, R, baseProf, ctl, onProgress, native); }
      catch (e) {
        if (ctl.cancel) throw new Error('cancelled');
        if (e.nativeEnc && native) { native = null; attempt--; continue; }   // the computer's own encoder failed: the browser's encoder instead
        if (e.message === 'cancelled' || attempt >= 2) throw friendly(e);
        // A phone that went to another app may take the video chip or the graphics card away: wait to be seen again, then start over.
        if (!hidden && !/GPU_LOST|reclaim|closed|DECODE|ENCODE/i.test(e.message || '')) throw friendly(e);
        while (document.visibilityState === 'hidden') { ctl.check(); await sleep(300); }
        hidden = false;
      }
    }
  } finally { document.removeEventListener('visibilitychange', vis); }
}
function friendly(e) {
  const m = e && e.message || String(e);
  if (/GPU_LOST/.test(m)) return new Error('The graphics card stopped (the phone may have needed it for something else). Try again.');
  if (/^DECODE/.test(m)) return Object.assign(new Error('This device could not read every frame of this clip (' + m.slice(8, 120) + ').'), { fallback: true });
  if (/^ENCODE/.test(m)) return Object.assign(new Error('This device could not write the result (' + m.slice(8, 120) + ').'), { fallback: true });
  return e;
}

const clone = o => JSON.parse(JSON.stringify(o));
const fmtS = s => s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)} s`;
const timesNote = () => ` [time: reading ${fmtS(TIMES.read - TIMES.upload)}, to the graphics card ${fmtS(TIMES.upload)}, picture ${fmtS(TIMES.picture)}, writing ${fmtS(TIMES.write)}, ${TIMES.starts} decoder starts]`;
async function runOnce(h0, R, baseProf, ctl, onProgress, native) {
  const gpu = newGpu(), notes = [], info0 = h0.info, v0 = h0.dm.video, srcs = [], stats = { passes: [] };
  const encs = [];   // the computer's own encoder (local Linux version) when there is one, else the browser's
  const mkEnc = async (w, h, fps, o) => {
    if (!(native && native.canEncode)) return new Encoder(w, h, fps, o).init();
    const e = new NativeEncoder(native, w, h, fps, o); encs.push(e);
    try { return await e.init(); } catch (x) { throw e.err(x); }
  };
  const timed = async (kind, frames, fn) => { const t = performance.now(), r = await fn(); stats.passes.push({ kind, frames, ms: performance.now() - t }); return r; };
  try {
    const doS = !!(R.smooth && R.smooth.on), doF = !!(R.fps && R.fps.on && R.fps.engine !== 'ai');
    // the work, in passes; weights for one progress bar
    const plan = [];
    let h = h0, inInfo = { ...info0 }, G = dispToCoded(v0), first = true;
    // cut (on the original clip): frame range
    const seek = R.cut.on ? Math.max(0, +R.cut.start || 0) : 0, len = R.cut.on && +R.cut.len > 0 ? +R.cut.len : Infinity;
    if (R.cut.on && seek >= info0.duration - 0.05) throw new Error('The start time is after the end of this clip');
    const F0 = info0.fps || 30, k0 = Math.max(0, Math.round(seek * F0)), k1 = Math.min(v0.count, Math.round(Math.min(info0.duration, seek + len) * F0));
    let range = { k0, n: Math.max(1, k1 - k0), F: F0 };
    const cap = maxMBps(baseProf) * 8e6;
    // ---- time passes first (Smooth out, Frame rate), with the turn and crop done in the first one
    let g = null;
    const timeGeom = () => { let m = G, w = inInfo.width, hh = inInfo.height; if (R.rotate.on) { const r = rotM(w, hh, R.rotate); m = mul(m, r.m); w = r.w; hh = r.h; }
      if (R.crop.on && R.crop.shape !== 'none') { const c = cropFor({ width: w, height: hh }, R.crop.shape, R.crop.pos), mm = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(c.filter || ''); if (mm) { m = mul(m, tr(+mm[3], +mm[4])); w = +mm[1]; hh = +mm[2]; } }
      return { m, w: w & ~1, h: hh & ~1 }; };
    const runTime = async (kind, build) => {
      const gm = first ? (timeGeom.done = timeGeom()) : { m: G, w: inInfo.width, h: inInfo.height };
      const src = new Source(h, gpu, { cache: 6 }); srcs.push(src);
      const p = build(gm); if (!p) { src.close(); return false; }
      const enc = await mkEnc(gm.w, gm.h, p.fps, { inter: true, gop: 8 });
      const [r, out] = await timed(kind, p.count, async () => { const r = await pass(gpu, src, { w: gm.w, h: gm.h, fps: p.fps, count: p.count, at: n => ({ ...p.at(n), H: gm.m, clip: null }), enc, gray: true, ctl, report: p.report, tag: kind }); return [r, await enc.finish()]; }); src.close();
      h = await reopen(out); inInfo = { ...h.info }; G = I3(); g = { data: r.grays, n: p.count };
      if (first) { first = false; range = { k0: 0, n: h.dm.video.count, F: p.fps }; }
      notes.push(p.note); return true;
    };
    // one progress bar over all passes, weighted by how heavy each one is
    const W = { scan: 1, pass: 3, motion: 6, loop: 3 }, heavy = e => e === 'motion' ? W.motion : W.pass;
    const total = (doS || doF) && !h0.grays ? W.scan : 0, sum = total + (doS ? W.pass : 0) + (doF ? heavy(R.fps.engine) : 0) + (R.slow.on ? heavy(R.slow.engine) : W.pass) + (R.loop.on ? W.loop : 0);
    let done = 0;
    const part = wgt => { const base = done; done += wgt; return x => onProgress && onProgress(Math.min(1, (base + wgt * Math.min(1, Math.max(0, x))) / sum)); };
    const sliceGrays = () => { const all = h0.grays; return all ? { data: all.data.subarray(range.k0 * 2304, (range.k0 + range.n) * 2304), n: range.n } : null; };
    if (doS || doF) {
      if (!h0.grays) await grays(h0, ctl, part(W.scan)); g = sliceGrays();
    }
    if (doS) {
      const F = chooseFps({ ...inInfo, fps: range.F }, { fps: 0, maxFps: 60 }), sp = ST.smoothPlan(g.data, g.n, F, { strength: Math.max(0, Math.min(100, +R.smooth.strength || 0)) / 100, dropOdd: R.smooth.dropOdd !== false });
      if (!sp.changed) notes.push('already even');
      else await runTime('sm', () => { const u = sp.u, keep = sp.keep, M = sp.outFrames, rep = part(W.pass);
        return { fps: F, count: M, report: rep, note: sp.drop.length ? 'smoothed, stray frames removed' : 'smoothed', at: n => {
          let j = 0, lo = 0, hi = u.length - 1; if (n >= u[hi]) j = hi; else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (u[m] <= n) lo = m; else hi = m; } j = lo; }
          const a = range.k0 + keep[j], b = range.k0 + keep[Math.min(keep.length - 1, j + 1)], w = j + 1 < u.length ? (n - u[j]) / Math.max(1e-9, u[j + 1] - u[j]) : 0;
          return { layers: [{ a, b, w: Math.max(0, Math.min(1, w)), mode: 'blend' }] }; } }; });
    }
    if (doF) {
      const F = range.F, T = +R.fps.target || 60, gg = g || sliceGrays();
      const pl = ST.fpsPlan(gg.data, gg.n, F, { target: T, engine: R.fps.engine, loop: R.fps.loop !== false, fix: R.fps.fix !== false });
      if (pl.skip) notes.push(pl.note);
      else await runTime('fr', () => {
        const N = gg.n, keep = [0];
        if (pl.dedupe) {   // like mpdecimate: a frame that is (almost) the same as the last one kept is dropped, and its time is shared out
          const d = []; for (let i = 0; i + 1 < N; i++) d.push(mdiff(gg.data, i, i + 1)); const mv = d.filter(x => x > 0.002).sort((a, b) => a - b), med = mv.length ? mv[mv.length >> 1] : 0.01, thr = Math.max(0.0015, 0.08 * med);
          for (let i = 1; i < N; i++) if (mdiff(gg.data, keep[keep.length - 1], i) >= thr) keep.push(i);
        } else for (let i = 1; i < N; i++) keep.push(i);
        const ks = keep.slice(); if (pl.wrap) ks.push(N + keep[0]);   // a loop is a circle: after the last frame comes the first
        const mode = R.fps.engine === 'motion' ? 'motion' : 'blend', rep = part(mode === 'motion' ? W.motion : W.pass);
        return { fps: T, count: pl.outFrames, report: rep, note: pl.note, at: n => {
          const t = n / T * F; let lo = 0, hi = ks.length - 1;
          if (t <= ks[0]) { lo = 0; hi = 0; } else if (t >= ks[hi]) lo = hi; else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ks[m] <= t) lo = m; else hi = m; }
          const b = Math.min(ks.length - 1, lo + 1), w = b > lo ? (t - ks[lo]) / (ks[b] - ks[lo]) : 0, fr = i => range.k0 + (ks[i] % N);
          return { layers: [{ a: fr(lo), b: fr(b), w: Math.max(0, Math.min(1, w)), mode }] }; } };
      });
    }
    // ---- the main pass
    const R3 = clone(R); R3.smooth.on = false; R3.fps.on = false;
    const timeDone = !first;
    if (timeDone) {   // the turn and the crop were done in the first pass: say so, as the ffmpeg way does
      const tg = timeGeom.done || {}; if (R.crop.on && R.crop.shape !== 'none' && tg.w) notes.unshift(`${tg.w}×${tg.h}`);
      if (R.rotate.on && ST.rotatePlan({ width: 2, height: 2 }, R.rotate).filter) notes.unshift('rotated');
      R3.cut.on = false; R3.rotate.on = false; R3.crop.on = false;
    }
    const rangeDur = timeDone ? inInfo.duration : Math.min(info0.duration - seek, len);
    const pInfo = { ...inInfo, fps: range.F, duration: rangeDur };
    const P = ST.planRecipe(pInfo, { ...R3, cut: { on: false, start: 0, len: 0 }, look: { ...R3.look, on: false } }, baseProf);
    notes.push(...P.notes.filter(x => !/^look/.test(x)));
    if (R.cut.on && !timeDone) notes.unshift(`cut ${seek ? 'from ' + seek + ' s' : ''}${len < Infinity ? ' ' + len + ' s' : ''}`.trim());
    const OF = chooseFps({ ...pInfo }, P.prof), [TW, TH] = P.size, Drep = P.duration, nRep = Math.max(1, Math.round(Drep * OF));
    const loopOn = !!R.loop.on, reps = loopOn ? 1 : repeatsNeeded(Drep, P.prof.minSeconds);
    // geometry: target pixel -> decoded picture pixel
    let m = G, w = inInfo.width, hh = inInfo.height;
    if (!timeDone) { const t = timeGeom(); m = t.m; w = t.w; hh = t.h; }
    if (R3.up.on) { const s = Math.max(1, +R3.up.scale || 2), uw = ST.even(w * s), uh = ST.even(hh * s); m = mul(m, sc(w / uw, hh / uh)); w = uw; hh = uh; }
    const sz = sizeM(w, hh, TW, TH, P.prof.fit); m = mul(m, sz.m);
    // time: output frame -> input time
    const slowOn = !!(R3.slow.on), sm = Math.max(1, +R3.slow.factor || 2), slowMode = R3.slow.mode || 'slow', slowStretch = slowOn && slowMode !== 'smooth' ? sm : 1;
    const lifeM = R3.life && R3.life.on ? ST.lifeMotion({ duration: Drep, fps: range.F }, R3.life, { minSeconds: P.prof.minSeconds, repeatAfter: loopOn, outFps: OF }) : null;
    const kbM = R3.kb && R3.kb.on ? ST.kenMotion({ duration: Drep, fps: range.F }, R3.kb, { minSeconds: P.prof.minSeconds, repeatAfter: loopOn, outFps: OF }) : null;
    const mode = slowOn ? (R3.slow.engine === 'motion' ? 'motion' : 'blend') : (lifeM && lifeM.A ? 'blend' : 'near');
    const sharp = R3.up.on ? Math.round(Math.max(0, Math.min(100, +R3.up.sharp || 0)) * 1.5) / 100 : 0;
    const perFrame = !!((lifeM && (lifeM.move || lifeM.glow || lifeM.trails)) || kbM);
    const count = nRep * reps, renderCount = perFrame ? count : nRep;
    const srcMain = new Source(h, gpu, { cache: mode === 'motion' ? 6 : 4, mips: (w * hh) / (TW * TH) > 2.5 || (inInfo.width * inInfo.height) / (TW * TH) > 2.5 }); srcs.push(srcMain);
    const nIn = timeDone ? h.dm.video.count : range.n, k0m = timeDone ? 0 : range.k0, Fin = range.F;
    const atMain = n => {
      const c = (n % nRep) / OF, Pt = lifeM ? lifeM.source(c) : c, s = Pt / slowStretch;
      const x = Math.max(0, Math.min(nIn - 1, s * Fin)), a = Math.floor(x), b = Math.min(nIn - 1, a + 1), wv = x - a;
      const layers = [mode === 'near' ? { a: k0m + (wv >= 0.5 ? b : a), b: null, w: 0 } : { a: k0m + a, b: k0m + b, w: wv, mode }];
      let H = m, clip = sz.clip;
      const kb = kbM && kbM.at(n, TW, TH), lf = lifeM && lifeM.at(n, TW, TH);
      const Hp = mul(kb ? persp(TW, TH, kb) : I3(), lf && lf.S ? persp(TW, TH, lf) : I3());
      if (kb || (lf && lf.S)) { H = mul(m, Hp); if (clip) clip = { ...clip, C: mul(clip.C, Hp) }; }
      return { layers, H, clip, sharp, bright: lf ? lf.bright : 0, sat: lf ? lf.sat : 1, trails: !!(lifeM && lifeM.trails) };
    };
    const encMain = await mkEnc(TW, TH, OF, loopOn ? { inter: true, gop: 8 } : { crf: P.prof.crf, gop: P.prof.gop || 30, cap, prof: P.prof });
    const rep = part(mode === 'motion' ? W.motion : W.pass);
    const [r, out] = await timed('mn', renderCount, async () => { const r = await pass(gpu, srcMain, { w: TW, h: TH, fps: OF, count: renderCount, at: atMain, enc: encMain, gray: loopOn, ctl, report: rep, tag: 'mn' }); return [r, await encMain.finish()]; }); srcMain.close();
    Object.assign(stats, { OF, Drep, nRep, reps, perFrame });
    if (!loopOn) {
      const note = notes.filter(Boolean).join(', ');
      return { data: toMp4(out, perFrame ? 1 : reps), note: note + timesNote(), stats };
    }
    // ---- Make it loop (what makeLoop does in loops.js)
    const N = nRep, rp = analyzeFrames(r.grays, N, OF);
    let method = R.loop.mode || 'auto';
    if (method === 'auto') method = rp.isLoop ? 'asis' : rp.bestCut >= 0 && rp.bestRatio <= 1.25 && rp.bestKeeps >= 0.6 ? 'trim' : (R.loop.fallback || 'pingpong');
    if (method === 'none') method = 'asis'; if (method === 'trim' && rp.bestCut < 0) method = R.loop.fallback || 'pingpong';
    const hl = await reopen(out), srcL = new Source(hl, gpu, { cache: 12 }); srcs.push(srcL);
    let frames, atL;
    const near = k => ({ layers: [{ a: k, b: null, w: 0 }], H: I3(), clip: null });
    if (method === 'asis') { frames = N; atL = near; }
    else if (method === 'trim') { frames = rp.bestCut + 1; atL = near; }
    else if (method === 'crossfade') {
      const xf = Math.min(Math.round((+R.loop.fade || 1.5) * OF), Math.floor(N / 3)); if (xf < 2) throw new Error('Clip is too short for a crossfaded loop');
      frames = N - xf; atL = k => { if (k >= xf) return near(k); const x = (k + 1) / (xf + 1), wv = x * x * x * (x * (x * 6 - 15) + 10);
        return { layers: [{ a: N - xf + k, b: null, w: 0 }, { a: k, b: null, w: 0, alpha: wv }], H: I3(), clip: null }; };
    } else {
      if (N < 3) throw new Error('Clip is too short to make a loop of');
      const A = N - 1, E = Math.min(Math.round(0.6 * OF), Math.floor(A / 3)), S = j => (j <= A ? j : 2 * A - j);
      if (E < 3) { frames = 2 * N - 2; atL = k => near(S(k)); }
      else {
        const seg = A - 2 * E + Math.PI * E, tf = J => J < E ? E * Math.acos(1 - J / E) : J > A - E ? seg - E * Math.acos(1 - (A - J) / E) : (E * Math.PI / 2 - E) + J;
        const Pj = j => (j >= A ? seg : 0) + tf(j >= A ? j - A : j), J2 = 2 * A, PT = Float64Array.from({ length: J2 + 1 }, (_, j) => Pj(j));
        frames = Math.round(2 * seg);
        atL = k => { let lo = 0, hi = J2; if (k >= PT[hi]) lo = hi; else while (hi - lo > 1) { const md = (lo + hi) >> 1; if (PT[md] <= k) lo = md; else hi = md; }
          const b = Math.min(J2, lo + 1), wv = b > lo ? (k - PT[lo]) / (PT[b] - PT[lo]) : 0; return { layers: [{ a: S(lo), b: S(b), w: Math.max(0, Math.min(1, wv)), mode: 'blend' }], H: I3(), clip: null }; };
      }
    }
    const encL = await mkEnc(TW, TH, OF, { crf: R.out.crf, gop: P.prof.gop || 30, cap, prof: P.prof });
    const outL = await timed('lp', frames, async () => { await pass(gpu, srcL, { w: TW, h: TH, fps: OF, count: frames, at: atL, enc: encL, ctl, report: part(W.loop), tag: 'lp' }); return encL.finish(); }); srcL.close();
    const weak = method === 'trim' && rp.bestRatio > 1.25;
    const what = { asis: rp.isLoop ? 'already loops' : 'kept as is', trim: `trimmed to the best loop point (frame ${rp.bestCut})` + (weak ? ' - no really good point exists, a small jump may remain' : ''), pingpong: 'played forward then backward', crossfade: `end crossfaded into the start (${R.loop.fade} s)` }[method];
    const reps2 = repeatsNeeded(frames / OF, P.prof.minSeconds);
    const note = [notes.filter(Boolean).join(', '), `${what}; before: ${reportText(rp)}`].filter(Boolean).join('; ');
    return { data: toMp4(outL, reps2), note: note + timesNote(), stats };
  } finally { for (const s of srcs) s.close(); for (const e of encs) e.close(); gpu.destroy(); }
}

// ---------------------------------------------------------------------------------------------- how long will it take?
// The recipe runs for real on the first second of the clip (without the loop step). Each pass reports how many frames it made and how
// long that took, so the estimate is: the fixed start-up cost, plus the cost of one frame of each pass times the frames that pass will
// make for the whole clip. Repeats that are copies cost nothing; repeats that change (Life, Ken Burns) are made frame by frame.
export async function estimate(h, R, baseProf, ctl, native = null) {
  const t0 = performance.now();
  try {
    const short = clone(R), D = h.info.duration, start = R.cut.on ? +R.cut.start || 0 : 0, avail = Math.max(0.2, Math.min(D - start, R.cut.on && +R.cut.len > 0 ? +R.cut.len : Infinity));
    const piece = Math.min(avail, 1.0), k = avail / piece; short.cut = { on: true, start, len: piece };
    // the loop step is timed too, with the method the whole clip will most likely get (on a short piece Auto could choose another one)
    const lm = R.loop.on ? loopForecast(h.loopRep || null, R.loop, 1).method : null;
    short.loop = R.loop.on ? { ...R.loop, on: true, mode: lm === 'trim' ? 'none' : lm } : { ...R.loop, on: false };
    if (!h.grays && ((R.smooth && R.smooth.on) || (R.fps && R.fps.on))) await grays(h, ctl);
    const M = Math.max(+R.out.minSeconds || 0, R.life.on ? +R.life.minSeconds || 0 : 0, R.kb.on ? +R.kb.minSeconds || 0 : 0);
    short.out.minSeconds = 0; short.life.minSeconds = 0; short.kb.minSeconds = 0;   // one round is enough to time; the repeats are counted below
    const t1 = performance.now(), r = await run(h, short, baseProf, { ctl, native }), total = (performance.now() - t1) / 1000, st = r.stats || { passes: [] };
    const per = kind => { const p = st.passes.filter(x => x.kind === kind); const f = p.reduce((a, x) => a + x.frames, 0), ms = p.reduce((a, x) => a + x.ms, 0); return f ? ms / 1000 / f : 0; };
    const inPasses = st.passes.reduce((a, x) => a + x.ms, 0) / 1000, fixed = Math.max(0, total - inPasses);
    let one = fixed;
    for (const kind of ['sm', 'fr']) { const p = st.passes.find(x => x.kind === kind); if (p) one += per(kind) * p.frames * k; }
    const OF = st.OF || 30, Drep = (st.Drep || piece) * k, nRep = Math.round(Drep * OF), reps = R.loop.on ? 1 : repeatsNeeded(Drep, M);
    const mainFrames = st.perFrame && !R.loop.on ? nRep * reps : nRep;
    one += per('mn') * mainFrames;
    if (R.loop.on) one += (per('lp') || per('mn')) * loopForecast(h.loopRep || null, R.loop, Drep).len * OF;   // the loop pass, at its own measured cost per frame
    return { one: one * 1.12 + 0.3, took: (performance.now() - t0) / 1000 };
  } catch (e) { if (e.message === 'cancelled') throw e; return null; }
}
