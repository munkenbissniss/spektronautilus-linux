// MP4 / MOV reading and writing, for the fast path that uses the device's own video chip (WebCodecs).
// demux(file): reads only the index (the 'moov' box) and hands out where every frame is in the file, so frames are read one at a time
//   straight from the file and never all held in memory.
// muxMp4(...): writes the encoded frames as a normal MP4 with the index first ("fast start"), like ffmpeg's +faststart.

const FOURCC = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
const hex2 = v => v.toString(16).padStart(2, '0').toUpperCase();

async function readAt(file, a, b) { return new DataView(await file.slice(a, b).arrayBuffer()); }

// boxes inside [start, end) of a DataView: [{ type, start (of payload), end, hdr }]
function boxes(dv, start = 0, end = dv.byteLength) {
  const out = []; let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o), hdr = 8; const type = FOURCC(dv, o + 4);
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type, start: o + hdr, end: o + size }); o += size;
  }
  return out;
}
const child = (dv, b, type) => b && boxes(dv, b.start, b.end).find(x => x.type === type);
const path = (dv, b, ...types) => { let c = b; for (const t of types) { c = child(dv, c, t); if (!c) return null; } return c; };

// the 'moov' box of a file, wherever it is (start or end); throws for files we cannot read this way
async function readMoov(file) {
  let o = 0; const n = file.size;
  while (o + 8 <= n) {
    const h = await readAt(file, o, Math.min(n, o + 16));
    let size = h.getUint32(0); const type = FOURCC(h, 4);
    if (size === 1) size = Number(h.getBigUint64(8)); else if (size === 0) size = n - o;
    if (size < 8) break;
    if (type === 'moov') { if (size > 200e6) throw new Error('index too large'); return new DataView(await file.slice(o, o + size).arrayBuffer()); }
    o += size;
  }
  throw new Error('no moov');
}

// The codec name WebCodecs wants, from the codec's own setup box.
function codecString(fmt, dv, cfg) {
  if (!cfg) return { codec: fmt === 'vp09' ? 'vp09.00.10.08' : null };
  const d = new Uint8Array(dv.buffer, dv.byteOffset + cfg.start, cfg.end - cfg.start);
  if (fmt === 'avc1' || fmt === 'avc3') return { codec: `${fmt}.${hex2(d[1])}${hex2(d[2])}${hex2(d[3])}`, description: d.slice(), name: 'h264' };
  if (fmt === 'hvc1' || fmt === 'hev1') {
    const ps = d[1] >> 6, tier = (d[1] >> 5) & 1, pidc = d[1] & 31;
    let compat = (d[2] << 24 | d[3] << 16 | d[4] << 8 | d[5]) >>> 0, rev = 0; for (let i = 0; i < 32; i++) { rev = (rev << 1 | (compat & 1)) >>> 0; compat >>>= 1; }
    const cons = Array.from(d.slice(6, 12)); while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    return { codec: `${fmt}.${['', 'A', 'B', 'C'][ps]}${pidc}.${rev.toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${d[12]}${cons.map(c => '.' + hex2(c)).join('')}`, description: d.slice(), name: 'hevc' };
  }
  if (fmt === 'vp09') { const p = d[4], l = d[5], bd = d[6] >> 4; return { codec: `vp09.${String(p).padStart(2, '0')}.${String(l).padStart(2, '0')}.${String(bd).padStart(2, '0')}`, name: 'vp9' }; }
  if (fmt === 'av01') { const p = d[1] >> 5, l = d[1] & 31, t = d[2] >> 7, hb = (d[2] >> 6) & 1, tb = (d[2] >> 5) & 1, bd = hb ? (tb ? 12 : 10) : 8; return { codec: `av01.${p}.${String(l).padStart(2, '0')}${t ? 'H' : 'M'}.${String(bd).padStart(2, '0')}`, description: d.slice(), name: 'av1' }; }
  return { codec: null };
}

// Everything about the video track that the fast path needs. Throws when the file is not an MP4/MOV with a video track it can read.
export async function demux(file) {
  const moov = await readMoov(file), top = { start: 8, end: moov.byteLength };
  if (child(moov, top, 'mvex')) throw new Error('fragmented');
  let video = null, hasAudio = false;
  for (const trak of boxes(moov, 8).filter(b => b.type === 'trak')) {
    const hdlr = path(moov, trak, 'mdia', 'hdlr'); if (!hdlr) continue;
    const kind = FOURCC(moov, hdlr.start + 8);
    if (kind === 'soun') { hasAudio = true; continue; }
    if (kind !== 'vide' || video) continue;
    const tkhd = child(moov, trak, 'tkhd'), mdhd = path(moov, trak, 'mdia', 'mdhd'), stbl = path(moov, trak, 'mdia', 'minf', 'stbl');
    if (!tkhd || !mdhd || !stbl) continue;
    const tv = moov.getUint8(tkhd.start), mo = tkhd.start + (tv === 1 ? 52 : 40);   // the display matrix (a b u / c d v / x y w)
    const fx = i => moov.getInt32(mo + i * 4) / 65536, M = { a: fx(0), b: fx(1), c: fx(3), d: fx(4) };
    const mv = moov.getUint8(mdhd.start), ts = moov.getUint32(mdhd.start + (mv === 1 ? 20 : 12));
    const stsd = child(moov, stbl, 'stsd'), ent = stsd && stsd.start + 8, fmt = ent && FOURCC(moov, ent + 4);
    if (!fmt) continue;
    const cw = moov.getUint16(ent + 8 + 24), ch = moov.getUint16(ent + 8 + 26);
    const entEnd = ent + moov.getUint32(ent), subs = boxes(moov, ent + 8 + 78, entEnd);
    const cfg = subs.find(b => ['avcC', 'hvcC', 'vpcC', 'av1C'].includes(b.type));
    const cs = codecString(fmt, moov, cfg);
    // sample tables
    const tab = t => child(moov, stbl, t), u32 = o => moov.getUint32(o);
    const stsz = tab('stsz'), stco = tab('stco') || tab('co64'), stsc = tab('stsc'), stts = tab('stts'), ctts = tab('ctts'), stss = tab('stss');
    if (!stsz || !stco || !stsc || !stts) continue;
    const n = u32(stsz.start + 8), uni = u32(stsz.start + 4);
    const sizes = new Uint32Array(n); for (let i = 0; i < n; i++) sizes[i] = uni || u32(stsz.start + 12 + 4 * i);
    const nc = u32(stco.start + 4), big = stco.type === 'co64', chunks = new Float64Array(nc);
    for (let i = 0; i < nc; i++) chunks[i] = big ? Number(moov.getBigUint64(stco.start + 8 + 8 * i)) : u32(stco.start + 8 + 4 * i);
    const ne = u32(stsc.start + 4), runs = []; for (let i = 0; i < ne; i++) runs.push([u32(stsc.start + 8 + 12 * i), u32(stsc.start + 12 + 12 * i)]);
    const offsets = new Float64Array(n); let s = 0;
    for (let r = 0; r < runs.length && s < n; r++) {
      const [first, per] = runs[r], last = r + 1 < runs.length ? runs[r + 1][0] - 1 : nc;
      for (let c = first; c <= last && s < n; c++) { let o = chunks[c - 1]; for (let k = 0; k < per && s < n; k++) { offsets[s] = o; o += sizes[s]; s++; } }
    }
    const dts = new Float64Array(n), dur = new Float64Array(n); let t = 0, i = 0;
    for (let e = 0, m = u32(stts.start + 4); e < m; e++) { const cnt = u32(stts.start + 8 + 8 * e), dl = u32(stts.start + 12 + 8 * e); for (let k = 0; k < cnt && i < n; k++, i++) { dts[i] = t; dur[i] = dl; t += dl; } }
    const cts = Float64Array.from(dts);
    if (ctts) { const cv = moov.getUint8(ctts.start); i = 0; for (let e = 0, m = u32(ctts.start + 4); e < m; e++) { const cnt = u32(ctts.start + 8 + 8 * e), off = cv === 1 ? moov.getInt32(ctts.start + 12 + 8 * e) : u32(ctts.start + 12 + 8 * e); for (let k = 0; k < cnt && i < n; k++, i++) cts[i] += off; } }
    let shift = 0; const elst = path(moov, trak, 'edts', 'elst');
    if (elst) { const ev = moov.getUint8(elst.start), m = u32(elst.start + 4); for (let e = 0; e < m; e++) { const o = elst.start + 8 + e * (ev === 1 ? 20 : 12); const mt = ev === 1 ? Number(moov.getBigInt64(o + 8)) : moov.getInt32(o + 4); if (mt >= 0) { shift = mt; break; } } }
    const key = new Uint8Array(n); if (stss) { for (let e = 0, m = u32(stss.start + 4); e < m; e++) { const k = u32(stss.start + 8 + 4 * e) - 1; if (k >= 0 && k < n) key[k] = 1; } } else key.fill(1);
    // presentation order: frame number -> sample number
    const order = Array.from({ length: n }, (_, k) => k).sort((x, y) => cts[x] - cts[y]);
    const pts = new Float64Array(n), first = n ? cts[order[0]] : 0; for (let k = 0; k < n; k++) pts[k] = (cts[order[k]] - Math.max(shift, first)) / ts;
    const total = t / ts;
    // display size and turn from the matrix (an iPhone portrait clip is stored wide and turned for display)
    const corner = (x, y) => [M.a * x + M.c * y, M.b * x + M.d * y], cs4 = [corner(0, 0), corner(cw, 0), corner(0, ch), corner(cw, ch)];
    const minX = Math.min(...cs4.map(p => p[0])), minY = Math.min(...cs4.map(p => p[1]));
    const dw = Math.round(Math.max(...cs4.map(p => p[0])) - minX), dh = Math.round(Math.max(...cs4.map(p => p[1])) - minY);
    const rot = ((Math.round(-Math.atan2(M.b, M.a) * 180 / Math.PI) % 360) + 360) % 360;   // counted the way ffmpeg reports it
    video = { fmt, codec: cs.codec, description: cs.description, name: cs.name || fmt, codedWidth: cw, codedHeight: ch, width: dw || cw, height: dh || ch,
      matrix: { ...M, tx: -minX, ty: -minY }, rotation: rot, timescale: ts, count: n, sizes, offsets, dts, cts, key, order, pts, duration: total,
      fps: n > 1 && total > 0 ? Math.round(n / total * 1000) / 1000 : 0 };
  }
  if (!video) throw new Error('no video track');
  return { video, hasAudio };
}

// the bytes of sample k (decode order)
export async function sampleData(file, v, k) { return new Uint8Array(await file.slice(v.offsets[k], v.offsets[k] + v.sizes[k]).arrayBuffer()); }

// ---------------------------------------------------------------------------------------------- writing
class W {
  constructor() { this.parts = []; this.len = 0; }
  bytes(u) { this.parts.push(u); this.len += u.length; return this; }
  u8(v) { return this.bytes(Uint8Array.of(v & 255)); }
  u16(v) { return this.bytes(Uint8Array.of(v >> 8 & 255, v & 255)); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return this.bytes(b); }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v | 0); return this.bytes(b); }
  str(s) { return this.bytes(new TextEncoder().encode(s)); }
  zero(n) { return this.bytes(new Uint8Array(n)); }
  out() { const o = new Uint8Array(this.len); let p = 0; for (const x of this.parts) { o.set(x, p); p += x.length; } return o; }
}
const box = (type, ...kids) => { const w = new W(); let n = 8; for (const k of kids) n += k.length; w.u32(n).str(type); for (const k of kids) w.bytes(k); return w.out(); };
const full = (type, v, flags, body) => box(type, new W().u8(v).u8(flags >> 16).u16(flags & 0xffff).bytes(body).out());
const MATRIX = new W().u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000).out();

// A frame rate as timescale / frame duration, exact for the NTSC rates.
export function fpsRational(f) {
  for (const [a, b] of [[24000, 1001], [30000, 1001], [60000, 1001]]) if (Math.abs(f - a / b) < 0.005) return { ts: a, dur: b };
  return { ts: Math.round(f * 1000), dur: 1000 };
}

// chunks: [{ data, key, pts }] in decode order; pts = frame number (presentation). codec 'avc' (description = avcC) or 'vp9'.
export function muxMp4({ codec, width, height, description, fps, chunks, vp9 = { profile: 0, level: 40, bitDepth: 8 } }) {
  const n = chunks.length, { ts, dur } = fpsRational(fps), total = n * dur;
  const sorted = chunks.every((c, i) => !i || c.pts > chunks[i - 1].pts);
  let entry;
  const visual = (fmt, ...kids) => box(fmt, new W().zero(6).u16(1).zero(16).u16(width).u16(height).u32(0x480000).u32(0x480000).u32(0).u16(1).zero(32).u16(0x18).u16(0xffff).out(), ...kids);
  const colr = box('colr', new W().str('nclx').u16(1).u16(1).u16(1).u8(0).out());
  if (codec === 'avc') entry = visual('avc1', box('avcC', description), colr);
  else entry = visual('vp09', full('vpcC', 1, 0, new W().u8(vp9.profile).u8(vp9.level).u8(vp9.bitDepth << 4 | 1 << 1).u8(1).u8(1).u8(1).u16(0).out()), colr);
  const stts = full('stts', 0, 0, new W().u32(1).u32(n).u32(dur).out());
  const keys = chunks.map((c, i) => c.key ? i + 1 : 0).filter(Boolean);
  const stss = full('stss', 0, 0, (() => { const w = new W().u32(keys.length); keys.forEach(k => w.u32(k)); return w.out(); })());
  const stsz = full('stsz', 0, 0, (() => { const w = new W().u32(0).u32(n); chunks.forEach(c => w.u32(c.data.length)); return w.out(); })());
  const stsc = full('stsc', 0, 0, new W().u32(1).u32(1).u32(n).u32(1).out());
  // frames out of order (B-frames): composition offsets, with the decode times pulled back by the largest reordering and an edit list to match
  let ctts = null, delay = 0;
  if (!sorted) {
    const offs = chunks.map((c, i) => (c.pts - i) * dur); delay = Math.max(0, -Math.min(...offs));
    const w = new W().u32(n); offs.forEach(o => w.u32(1).u32(o + delay)); ctts = full('ctts', 0, 0, w.out());
  }
  const moovFor = off => {
    const stco = full('stco', 0, 0, new W().u32(1).u32(off).out());
    const stbl = box('stbl', full('stsd', 0, 0, new W().u32(1).bytes(entry).out()), stts, ...(ctts ? [ctts] : []), stss, stsz, stsc, stco);
    const minf = box('minf', full('vmhd', 0, 1, new W().zero(8).out()), box('dinf', full('dref', 0, 0, new W().u32(1).bytes(full('url ', 0, 1, new Uint8Array(0))).out())), stbl);
    const hdlr = full('hdlr', 0, 0, new W().u32(0).str('vide').zero(12).str('VideoHandler').u8(0).out());
    const mdhd = full('mdhd', 0, 0, new W().u32(0).u32(0).u32(ts).u32(total).u16(0x55c4).u16(0).out());
    const msDur = Math.round(total / ts * 1000);
    const edts = delay ? box('edts', full('elst', 0, 0, new W().u32(1).u32(msDur).u32(delay).u32(0x10000).out())) : new Uint8Array(0);
    const tkhd = full('tkhd', 0, 3, new W().u32(0).u32(0).u32(1).u32(0).u32(msDur).zero(8).u16(0).u16(0).u16(0).u16(0).bytes(MATRIX).u32(width << 16).u32(height << 16).out());
    const trak = box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
    const mvhd = full('mvhd', 0, 0, new W().u32(0).u32(0).u32(1000).u32(msDur).u32(0x10000).u16(0x100).zero(10).bytes(MATRIX).zero(24).u32(2).out());
    return box('moov', mvhd, trak);
  };
  const ftyp = box('ftyp', new W().str('isom').u32(0x200).str('isom').str('iso2').str(codec === 'avc' ? 'avc1' : 'iso6').str('mp41').out());
  const size0 = moovFor(0).length, mdatLen = chunks.reduce((a, c) => a + c.data.length, 0), off = ftyp.length + size0 + 8;
  const moov = moovFor(off), out = new Uint8Array(ftyp.length + moov.length + 8 + mdatLen);
  out.set(ftyp, 0); out.set(moov, ftyp.length); let p = ftyp.length + moov.length;
  new DataView(out.buffer).setUint32(p, 8 + mdatLen); out.set(new TextEncoder().encode('mdat'), p + 4); p += 8;
  for (const c of chunks) { out.set(c.data, p); p += c.data.length; }
  return out;
}
