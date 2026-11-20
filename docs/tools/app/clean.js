// Finding logos and text that sit on top of a clip (a channel logo, a watermark, a web address along the edge).
// Such overlays stay exactly where they are while the picture under them changes, they have crisp, strong edges, and they are almost
// always near the edge of the picture. Many frames from the whole clip are compared: what never changes and has sharp edges is a
// candidate; candidates near the edge, dense with edges and with their own colour score highest.
// In a clip where hardly anything moves, part of the scene can look like a logo too, so the boxes are suggestions: the person chooses.
//
//   detect(frames, W, H)          frames: RGB(A) pixel arrays of W x H (a small copy of the picture, about 360 px wide)
//                                 -> [{ box: [x, y, w, h] (parts 0..1), score, sure }] best first
//   findOverlays(url, opts)       the same for a video file (a URL the page can play), frames taken with a video element

const lum = (d, i, st) => 0.299 * d[i * st] + 0.587 * d[i * st + 1] + 0.114 * d[i * st + 2];

export function detect(frames, W, H, { stride = 0 } = {}) {
  const N = frames.length, P = W * H; if (!N || !P) return [];
  const st = stride || Math.round(frames[0].length / P);   // 3 (RGB) or 4 (RGBA)
  // per pixel over time: the middle (median) brightness and colour, and how much it changes
  const med = new Float32Array(P), sd = new Float32Array(P), sat = new Float32Array(P), col = new Float32Array(N), cr = new Float32Array(N);
  for (let i = 0; i < P; i++) {
    let s = 0, s2 = 0;
    for (let k = 0; k < N; k++) {
      const d = frames[k], v = lum(d, i, st); col[k] = v; s += v; s2 += v * v;
      const r = d[i * st], g = d[i * st + 1], b = d[i * st + 2]; cr[k] = Math.max(r, g, b) - Math.min(r, g, b);
    }
    col.sort(); cr.sort(); med[i] = col[N >> 1]; sat[i] = cr[N >> 1];
    sd[i] = Math.sqrt(Math.max(0, s2 / N - (s / N) * (s / N)));
  }
  // edges of the middle picture (Sobel)
  const E = new Float32Array(P);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, a = med[i - W - 1], b = med[i - W], c = med[i - W + 1], d = med[i - 1], f = med[i + 1], g = med[i + W - 1], h = med[i + W], k = med[i + W + 1];
    const gx = (c + 2 * f + k) - (a + 2 * d + g), gy = (g + 2 * h + k) - (a + 2 * b + c); E[i] = Math.hypot(gx, gy) / 4;
  }
  const sorted = Float32Array.from(sd).sort(), q = p => sorted[Math.min(P - 1, Math.floor(p * P))];
  const stillT = Math.max(2.5, Math.min(6, q(0.05) * 3));   // what never changes more than video noise does
  let moving = 0; for (let i = 0; i < P; i++) if (sd[i] > 6) moving++; moving /= P;
  const cand = new Uint8Array(P); for (let i = 0; i < P; i++) cand[i] = sd[i] < stillT && E[i] > 40 ? 1 : 0;
  // join nearby candidate pixels into blobs: grow by 3, then a closing (grow 3, shrink 3)
  const grow = (m, r) => { const o = new Uint8Array(P); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!m[y * W + x]) continue; for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) o[yy * W + xx] = 1; } } } return o; };
  const shrink = (m, r) => { const inv = new Uint8Array(P); for (let i = 0; i < P; i++) inv[i] = m[i] ? 0 : 1; const g = grow(inv, r), o = new Uint8Array(P); for (let i = 0; i < P; i++) o[i] = g[i] ? 0 : 1; return o; };
  const blob = shrink(grow(grow(cand, 3), 3), 3);
  // connected parts
  const lab = new Int32Array(P), parts = []; let n = 0; const stack = [];
  for (let i0 = 0; i0 < P; i0++) {
    if (!blob[i0] || lab[i0]) continue;
    n++; const pt = { x0: W, y0: H, x1: 0, y1: 0, px: 0, c: 0, s: 0, v: 0, a0: W, b0: H, a1: 0, b1: 0 }; lab[i0] = n; stack.push(i0);
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i / W) | 0;
      pt.px++; pt.c += cand[i]; pt.s += sat[i]; pt.v += sd[i];
      if (x < pt.x0) pt.x0 = x; if (y < pt.y0) pt.y0 = y; if (x + 1 > pt.x1) pt.x1 = x + 1; if (y + 1 > pt.y1) pt.y1 = y + 1;
      if (cand[i]) { if (x < pt.a0) pt.a0 = x; if (y < pt.b0) pt.b0 = y; if (x + 1 > pt.a1) pt.a1 = x + 1; if (y + 1 > pt.b1) pt.b1 = y + 1; }   // the sharp pixels alone
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) if (j >= 0 && blob[j] && !lab[j]) { lab[j] = n; stack.push(j); }
    }
    parts.push(pt);
  }
  const satS = Float32Array.from(sat).sort(), satMed = satS[P >> 1];
  const out = [];
  for (const p of parts) {
    const bw = p.x1 - p.x0, bh = p.y1 - p.y0, area = bw * bh;
    if (area < 0.002 * P || area > 0.12 * P) continue;   // a speck, or something too big to be a logo
    // how much of it is sharp, still edges: counted inside the box of the sharp pixels themselves, so thin letters count as fully as a block logo
    const dens = p.c / Math.max(1, (p.a1 - p.a0) * (p.b1 - p.b0)); if (dens < 0.2) continue;   // only a few sharp pixels: texture of the scene
    const edge = Math.min(p.x0, p.y0, W - p.x1, H - p.y1) / Math.min(W, H), border = Math.max(0, 1 - edge / 0.2);
    const colour = Math.max(0, Math.min(1, (p.s / p.px - satMed) / 60)), stillness = 1 - Math.max(0, Math.min(1, p.v / p.px / 3));
    const score = dens * 1.5 + border + colour * 0.6 + stillness * 0.3 * Math.min(1, moving * 20);
    // a little room around it, so the soft edge of the logo goes too
    const pad = Math.max(2, Math.round(Math.min(W, H) * 0.012));
    const x0 = Math.max(0, p.x0 - pad), y0 = Math.max(0, p.y0 - pad), x1 = Math.min(W, p.x1 + pad), y1 = Math.min(H, p.y1 + pad);
    out.push({ box: [x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H], score: Math.round(score * 100) / 100, sure: score >= 1.5 && (moving >= 0.15 || (border >= 0.95 && dens >= 0.35)) });   // in a clip where almost nothing moves, only what sits right at the edge is chosen at once
  }
  out.sort((a, b) => b.score - a.score);
  return out.filter(o => o.score >= 1.0).slice(0, 6);
}

// frames from a video file: a video element seeks to times spread over the clip, and each picture is drawn small
export async function findOverlays(url, { frames = 24, width = 360, onProgress, signal } = {}) {
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'; v.src = url;
  const wait = (ev, ms = 8000) => new Promise((res, rej) => { const t = setTimeout(() => { v.removeEventListener(ev, ok); rej(new Error('The video did not answer')); }, ms); const ok = () => { clearTimeout(t); v.removeEventListener(ev, ok); res(); }; v.addEventListener(ev, ok); });
  try {
    if (v.readyState < 1) await wait('loadedmetadata');
    const W = width, H = Math.max(16, Math.round(width * (v.videoHeight || 9) / (v.videoWidth || 16) / 2) * 2), dur = v.duration || 0;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
    const got = [];
    for (let k = 0; k < frames; k++) {
      if (signal && signal.aborted) throw new Error('cancelled');
      const t = dur > 0 ? Math.min(dur - 0.05, (k + 0.5) / frames * dur) : 0;
      if (Math.abs(v.currentTime - t) > 1e-3) { const p = wait('seeked'); v.currentTime = t; await p; } else if (v.readyState < 2) await wait('loadeddata');
      g.drawImage(v, 0, 0, W, H); got.push(g.getImageData(0, 0, W, H).data);
      if (onProgress) onProgress((k + 1) / frames);
    }
    return { W, H, found: detect(got, W, H, { stride: 4 }), frame: got[got.length >> 1] };
  } finally { v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ } }
}
