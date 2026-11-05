// Treatment steps shared by the Tools page and the Loop Hospital.
// Each helper returns a piece of an ffmpeg filter graph (no AI needed, works in the browser too).
import { encodeArgs, cropFor, chooseFps, targetSize, repeatsNeeded, v2xVbvArgs, aiDevice } from './core.js';
import { filterChain } from './filters.js';

const r3 = v => Math.round(v * 1000) / 1000;
export const even = v => Math.max(2, Math.round(v / 2) * 2);

// Sharp upscale: Lanczos resize followed by a gentle sharpening. sharp = 0..100
export function upscalePlan(info, scale, sharp = 50) {
  const s = Math.max(1, +scale || 2), w = even(info.width * s), h = even(info.height * s);
  const amt = Math.round(Math.max(0, Math.min(100, +sharp || 0)) * 1.5) / 100;
  return { filter: `scale=${w}:${h}:flags=lanczos` + (amt > 0 ? `,unsharp=5:5:${amt}:5:5:0` : ''), width: w, height: h };
}

// Rotate and mirror. turn: '0' | '90' (clockwise) | '270' (counter-clockwise) | '180'. flip: 'none' | 'h' | 'v'.
export function rotatePlan(info, { turn = '90', flip = 'none' } = {}) {
  const f = [], t = String(turn);
  if (t === '90') f.push('transpose=1'); else if (t === '270') f.push('transpose=2'); else if (t === '180') f.push('hflip', 'vflip');
  if (flip === 'h') f.push('hflip'); else if (flip === 'v') f.push('vflip');
  const swap = t === '90' || t === '270';
  return { filter: f.join(','), width: swap ? info.height : info.width, height: swap ? info.width : info.height, swap };
}

// One finished file for every look the patient should get (plus the plain clip when keepOriginal is on).
// Returns [{ suffix, rec }]. With one look or none, a single entry with an empty suffix.
export function variants(R) {
  if (!R.look.on) return [{ suffix: '', rec: R }];
  const ids = (R.look.ids && R.look.ids.length ? R.look.ids : [R.look.id]).filter(Boolean), out = [];
  if (ids.length <= 1 && !R.look.keepOriginal) return [{ suffix: '', rec: { ...R, look: { ...R.look, id: ids[0] || R.look.id } } }];
  if (R.look.keepOriginal) out.push({ suffix: '', rec: { ...R, look: { ...R.look, on: false } } });
  for (const id of ids) out.push({ suffix: id, rec: { ...R, look: { ...R.look, on: true, id } } });
  return out;
}

// Slow motion without AI. engine: 'blend' (fast, soft) or 'motion' (motion interpolation, slow but cleaner on fast movement).
// mode 'slow': the clip gets `factor` times longer at the same frame rate. mode 'smooth': same speed, more frames per second (up to 60).
export function slowPlan(info, { factor = 2, mode = 'slow', engine = 'blend' } = {}) {
  const m = Math.max(1, +factor || 2), F = info.fps || 25;
  const interp = to => engine === 'motion' ? `minterpolate=fps=${to}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : `framerate=fps=${to}`;
  if (mode === 'smooth') {
    const to = r3(Math.min(60, F * m));
    if (to <= F + 0.01) return { pre: '', fps: 0, durMul: 1, note: 'already smooth' };
    return { pre: interp(to), fps: to, durMul: 1, note: `${Math.round(F)} → ${Math.round(to)} fps` };
  }
  if (m <= 1) return { pre: '', fps: 0, durMul: 1, note: '' };
  return { pre: `${interp(r3(F * m))},setpts=${m}*PTS`, fps: 0, durMul: m, note: `${m}× slower` };
}

// ---------------------------------------------------------------------------------------------- Smooth out: even speed, no odd frames
// Looks at how much the picture moves from frame to frame (data = grey 64x36 pictures, n of them, at `fps`).
//  1. A frame that is far from both neighbours but close to the frame two steps away is a stray frame: it is dropped.
//  2. The speed (movement per frame) is compared with the speed around it. Where the picture lurches ahead, time is stretched; where it
//     crawls, time is squeezed. `strength` 0..1 says how much of the difference is taken out. The clip may end up a little shorter or longer.
// Returns { drop: [frame numbers], expr: setpts expression (after the dropped frames are removed), frames, outFrames, before, after }.
const W36 = 64 * 36;
const mdiff = (d, a, b) => { let s = 0; const oa = a * W36, ob = b * W36; for (let i = 0; i < W36; i++) s += Math.abs(d[oa + i] - d[ob + i]); return s / W36 / 255; };
const median = a => { const b = Array.from(a).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
export function smoothPlan(data, n, fps, { strength = 0.7, dropOdd = true } = {}) {
  const F = fps || 25, none = { drop: [], expr: '', frames: n, outFrames: n, before: 0, after: 0, changed: false };
  if (n < 12) return none;
  let idx = Array.from({ length: n }, (_, i) => i);
  const steps = ix => { const o = new Float64Array(ix.length - 1); for (let i = 0; i < o.length; i++) o[i] = mdiff(data, ix[i], ix[i + 1]); return o; };
  let d = steps(idx); const drop = [];
  if (dropOdd) {
    const med = (i) => median(d.subarray(Math.max(0, i - 15), Math.min(d.length, i + 16)));
    for (let i = 1; i < n - 1; i++) {
      const a = d[i - 1], b = d[i], m = Math.max(med(i), 1e-4), lo = Math.min(a, b);
      if (lo > 1.8 * m && mdiff(data, i - 1, i + 1) < 0.75 * lo && !(drop.length && drop[drop.length - 1] === i - 1)) drop.push(i);
    }
    if (drop.length) { const ds = new Set(drop); idx = idx.filter(i => !ds.has(i)); d = steps(idx); }
  }
  const m = idx.length, E = m - 1, box = (a, r) => { const o = new Float64Array(a.length); for (let i = 0; i < a.length; i++) { let s = 0, c = 0; for (let k = Math.max(0, i - r); k <= Math.min(a.length - 1, i + r); k++) { s += a[k]; c++; } o[i] = s / c; } return o; };
  const floor = Math.max(median(d) * 0.15, 5e-4), ds = box(d, 1).map(x => Math.max(x, floor)), v = box(ds, Math.max(3, Math.round(1.5 * F)));
  const k = Math.min(1, Math.max(0, strength));
  const dt = box(Float64Array.from(ds, (x, i) => Math.min(4.5, Math.max(0.3, Math.pow(x / v[i], k)))), 1);   // output frames spent on this source step
  const u = new Float64Array(m); for (let i = 0; i < E; i++) u[i + 1] = u[i] + dt[i];
  const spread = a => { const s = box(a, 2), q = Array.from(s.subarray(3, Math.max(4, s.length - 3))); return q.length ? Math.max(...q) / Math.max(Math.min(...q), 1e-9) : 1; };
  const out = new Float64Array(E); for (let i = 0; i < E; i++) out[i] = ds[i] / dt[i];
  // keep only the points where the time curve bends (a lurch of one frame needs a point of its own), as a balanced tree of if()s
  const simplify = tol => { const keep = [0, E], stack = [[0, E]]; while (stack.length) { const [a, b] = stack.pop(); let w = -1, wd = tol; for (let i = a + 1; i < b; i++) { const e = Math.abs(u[i] - (u[a] + (u[b] - u[a]) * (i - a) / (b - a))); if (e > wd) { wd = e; w = i; } } if (w > 0) { keep.push(w); stack.push([a, w], [w, b]); } } return keep.sort((x, y) => x - y); };
  let tol = 0.2, knots = simplify(tol); while (knots.length > 300 && tol < 8) { tol *= 1.6; knots = simplify(tol); }
  const r4 = x => String(Math.round(x * 10000) / 10000), T = i => r4(i / F), U = i => r4(u[i] / F);
  const build = (lo, hi) => {   // piecewise linear: new time as a function of old time, knots lo..hi
    if (hi - lo === 1) { const a = knots[lo], b = knots[hi]; return `${U(a)}+(T-${T(a)})*${r4((u[b] - u[a]) / (b - a))}`; }
    const mid = (lo + hi) >> 1; return `if(lt(T,${T(knots[mid])}),${build(lo, mid)},${build(mid, hi)})`;
  };
  const expr = build(0, knots.length - 1);
  return { drop, expr: `setpts='(${expr})/TB'`, frames: m, outFrames: Math.round(u[E]) + 1, before: spread(ds), after: spread(out), changed: drop.length > 0 || k > 0 };
}
export const smoothChain = (plan, fps) => [
  plan.drop.length ? `select='not(${plan.drop.map(i => `eq(n,${i})`).join('+')})',setpts=N/${fps}/TB` : '',
  plan.expr.replace(/\bT\b/g, '(PTS*TB)'),
  `framerate=fps=${fps}:interp_start=0:interp_end=255:scene=100`,
].filter(Boolean).join(',');


// ---------------------------------------------------------------------------------------------- Frame rate: 60 fps without stutter
// New frames are made between the old ones (a blend, or motion interpolation), by timestamp, so a 24 fps clip does not get frames repeated in an
// uneven rhythm. Two things keep it smooth: (1) a clip that loops is treated as a circle, so the new frames across the seam are made from the last
// and the first frame, and the result has exactly the same length; (2) frames that are only repeated copies (animation shot on twos, or a 12 fps
// clip in a 30 fps file) are removed first, so the movement is spread over the time they were held and no longer moves in steps.
export function fpsPlan(data, n, fps, { target = 60, engine = 'blend', loop = true, fix = true } = {}) {
  const F = fps || 25, T = Math.max(1, +target || 60);
  if (n < 4 || T <= F + 0.5) return { skip: true, note: `already ${Math.round(F)} fps`, frames: n };
  const d = new Float64Array(n - 1); for (let i = 0; i < n - 1; i++) d[i] = mdiff(data, i, i + 1);
  const moving = Array.from(d).filter(x => x > 0.002), med = median(moving) || 0.01, same = Array.from(d).filter(x => x < Math.max(0.0015, 0.08 * med)).length / d.length;
  const ref = Math.max(Array.from(d).sort((a, b) => a - b)[Math.floor((d.length - 1) * 0.9)], 0.004), wrap = mdiff(data, n - 1, 0);
  const isLoop = !!loop && (wrap / ref <= 3 || wrap < 0.01), dedupe = !!fix && same >= 0.15;
  const interp = engine === 'motion' ? `minterpolate=fps=${T}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : `framerate=fps=${T}:interp_start=0:interp_end=255:scene=${dedupe ? 100 : 40}`;
  const M = Math.round(n / F * T);
  return { skip: false, chain: [dedupe ? 'mpdecimate' : '', interp].filter(Boolean).join(','), wrap: isLoop, dedupe, frames: n, outFrames: M, repeated: same, target: T,
    note: `${Math.round(F * 100) / 100} → ${T} fps${engine === 'motion' ? ' (smooth motion)' : ''}${isLoop ? ', loop seam kept' : ''}${dedupe ? ', stepping removed' : ''}` };
}

// ---------------------------------------------------------------------------------------------- "Bring it to life": organic motion for still loops
// Everything here is periodic over a whole number of loop lengths, so the result still loops without a seam.
//   ease    slow in and out: the clip lingers around the loop point and glides through the middle (speed changes, length does not)
//   breathe a slow zoom in and out        drift  a floating sideways/up-down movement      sway  a very small tilt
//   glow    brightness and colour breathing                                              trails  soft ghosts of the last frames
export const LIFE_STYLES = {
  calm:   { ease: 40, breathe: 30, drift: 0,  sway: 0,  glow: 0,  trails: false },
  float:  { ease: 30, breathe: 20, drift: 50, sway: 30, glow: 0,  trails: false },
  dream:  { ease: 50, breathe: 35, drift: 35, sway: 20, glow: 30, trails: true },
  pulse:  { ease: 20, breathe: 45, drift: 0,  sway: 0,  glow: 50, trails: false },
};
// One "breath" lasts a whole number of loop lengths that fits into the final length, and it can be long (up to 32 s), so the movement glides.
export function lifePeriod(D, minSeconds, repeatAfter) {
  if (!(D > 0)) return { P: 8, n: 1, T: 0 };
  const n = repeatAfter ? 1 : repeatsNeeded(D, minSeconds || 0);
  let m = 1; for (let k = n; k >= 1; k--) if (n % k === 0 && D * k <= 32) { m = k; break; }
  return { P: D * m, n, T: D * n };
}
const fnum = v => String(Math.round(v * 10000) / 10000);
// One `perspective` filter that scales (S), moves (cx, cy are the middle of the view in pixels) and tilts (t) the picture, every frame.
function perspFilter(S, cx, cy, t) {
  const hw = `(W/(2*${S}))`, hh = `(H/(2*${S}))`, q = e => `'${e}'`;
  return `perspective=eval=frame:sense=source:interpolation=cubic:x0=${q(`${cx}-${hw}+${hh}*${t}`)}:y0=${q(`${cy}-${hw}*${t}-${hh}`)}:x1=${q(`${cx}+${hw}+${hh}*${t}`)}:y1=${q(`${cy}+${hw}*${t}-${hh}`)}:x2=${q(`${cx}-${hw}-${hh}*${t}`)}:y2=${q(`${cy}-${hw}*${t}+${hh}`)}:x3=${q(`${cx}+${hw}-${hh}*${t}`)}:y3=${q(`${cy}+${hw}*${t}+${hh}`)}`;
}
export function lifePlan(info, L, { minSeconds = 0, repeatAfter = false, outFps = 0 } = {}) {
  const D = info.duration || 0, F = info.fps || 25, OF = outFps || F, c = v => Math.max(0, Math.min(100, +v || 0)) / 100, { P, T } = lifePeriod(D, minSeconds, repeatAfter);
  const ease = c(L.ease), breathe = c(L.breathe), drift = c(L.drift), sway = c(L.sway), glow = c(L.glow), notes = [];
  let pre = '', extra = []; const f = fnum;
  if (ease > 0 && D > 0) {       // time stretches by 1 + a·cos around the loop point: it lingers at the start and end and glides through the middle, gently (a is at most 0.45; it used to be up to 0.85)
    const a = ease * 0.45, A = f(a * D / (2 * Math.PI));
    pre = `${F <= 31 ? `framerate=fps=${f(F * 2)},` : ''}setpts='PTS+${A}*sin(2*PI*PTS*TB/${f(D)})/TB'`; notes.push('slow in and out');
  }
  if (breathe > 0 || drift > 0 || sway > 0) {
    const zA = breathe * 0.10, dA = drift * 0.03, th = sway * 0.015, marg = Math.min(0.35, 2 * dA + 3.6 * th + 0.006), s0 = 1 / (1 - marg);
    const p1 = `(2*PI*on/${f(P * OF)})`, S = `(${f(s0)}+${f(zA)}*(0.5-0.5*cos(${p1})))`;
    const cx = `(W/2+W*${f(dA)}*(sin(${p1}+0.7)+0.5*sin(2*${p1}+2.1))/1.5)`, cy = `(H/2+H*${f(dA * 0.7)}*(cos(${p1}+1.3)+0.5*sin(2*${p1}+0.4))/1.5)`;
    extra.push(perspFilter(S, cx, cy, `(${f(th)}*sin(${p1}+2))`));
    if (breathe > 0) notes.push('breathing zoom'); if (drift > 0) notes.push('floating'); if (sway > 0) notes.push('gentle tilt');
  }
  if (glow > 0) { extra.push(`eq=brightness='${f(0.05 * glow)}*sin(2*PI*t/${f(P)})':saturation='1+${f(0.25 * glow)}*sin(2*PI*t/${f(P)}+1.1)':eval=frame`); notes.push('light breathing'); }
  if (L.trails) { extra.push(`tmix=frames=4:weights='4 3 2 1'`); notes.push('soft trails'); }
  return { pre, extra: extra.join(','), notes, period: P, total: T };
}

// ---------------------------------------------------------------------------------------------- Ken Burns: a slow zoom or pan over the whole clip
// The movement runs once over the whole result, eased at both ends. With `ret` it glides back to where it began, so the clip still loops without a jump.
// A pan or zoom never shows an edge: the picture is enlarged just enough for the path it takes.
export const KB_MODES = [['zoomin', 'Slow zoom in'], ['zoomout', 'Slow zoom out'], ['panlr', 'Pan left to right'], ['panrl', 'Pan right to left'], ['panup', 'Pan upwards'], ['pandown', 'Pan downwards'], ['drift', 'Drift in (zoom and sideways)']];
export function kenPlan(info, K, { minSeconds = 0, repeatAfter = false, outFps = 0 } = {}) {
  const D = info.duration || 0, OF = outFps || info.fps || 25, f = fnum, { T } = lifePeriod(D, minSeconds, repeatAfter);
  const amt = Math.max(0, Math.min(100, +K.amount || 0)) / 100;
  if (!(T > 0) || amt <= 0) return { extra: '', notes: [], total: T };
  const N = Math.max(1, T * OF), u = `(on/${f(N)})`, p = K.ret === false ? `(${u}*${u}*(3-2*${u}))` : `(0.5-0.5*cos(2*PI*${u}))`;
  const z = amt * 0.3, a = amt * 0.12, mode = K.mode;
  let S = '1', cx = '(W/2)', cy = '(H/2)';
  if (mode === 'zoomin') S = `(1+${f(z)}*${p})`;
  else if (mode === 'zoomout') S = `(1+${f(z)}*(1-${p}))`;
  else if (mode === 'panlr' || mode === 'panrl') { S = f(1 / (1 - 2 * a)); cx = `(W*(0.5${mode === 'panlr' ? '-' : '+'}${f(a)}*(1-2*${p})))`; }
  else if (mode === 'panup' || mode === 'pandown') { S = f(1 / (1 - 2 * a)); cy = `(H*(0.5${mode === 'panup' ? '+' : '-'}${f(a)}*(1-2*${p})))`; }
  else {   // drift: zoom in while the middle slides towards a corner; the slide stays inside what the zoom leaves free
    const room = 0.5 - 1 / (2 * (1 + z)); S = `(1+${f(z)}*${p})`; cx = `(W*(0.5+${f(0.8 * room)}*${p}))`; cy = `(H*(0.5-${f(0.6 * room)}*${p}))`;
  }
  const label = (KB_MODES.find(m => m[0] === mode) || KB_MODES[0])[1].toLowerCase();
  return { extra: perspFilter(S, cx, cy, '0'), notes: ['Ken Burns: ' + label], total: T };
}

// What is wrong with this clip, and what would help? info: probe result, loop: loop report (or null)
export function diagnose(info, loop, { slowEngine = false } = {}) {
  const out = [];
  if (slowEngine && info.duration > 10) out.push({ id: 'long', text: `This clip is ${Math.round(info.duration)} s long. Slow motion, upscale and loop fixes can take a very long time in a browser, especially on a phone. Cut it short first, or use the local version.`, fix: { cut: { on: true, start: 0, len: 8 } } });
  const short = Math.min(info.width, info.height);
  if (info.width && short < 720) out.push({ id: 'small', text: `Small picture (${info.width}×${info.height}). It will look soft on a big screen.`, fix: { up: { on: true, scale: short < 400 ? 4 : 2 } } });
  if (info.duration && info.duration < 4) out.push({ id: 'short', text: `Very short (${Math.round(info.duration * 10) / 10} s). Slow motion makes it longer and calmer.`, fix: { slow: { on: true, factor: 2 } } });
  else if (info.fps && info.fps < 20) out.push({ id: 'lowfps', text: `Low frame rate (${Math.round(info.fps)} fps). Smooth mode adds frames.`, fix: { slow: { on: true, factor: 2, mode: 'smooth' } } });
  if (info.duration && info.duration < 16) out.push({ id: 'still', text: `Only ${Math.round(info.duration * 10) / 10} s long. Short or still loops get much more interesting with slow-in-and-out motion and a gentle breathing zoom, repeated to 16 s.`, fix: { life: { ...LIFE_STYLES.calm, style: 'calm', minSeconds: 16 } } });
  if (loop && loop.verdict && loop.verdict !== 'seamless') out.push({ id: 'jump', text: loop.verdict === 'almost' ? 'The loop point is almost clean. A small fix will hide the jump.' : 'You can see a jump where the clip starts over.', fix: { loop: { mode: 'auto' } } });
  if (info.hasAudio) out.push({ id: 'audio', text: 'This clip has sound. The treated clip will be silent, which suits loops for mixing.', fix: {} });
  if (info.isGif) out.push({ id: 'gif', text: 'A GIF. It will become a smooth mp4.', fix: {} });
  return out;
}

export const defaultRecipe = () => ({
  cut: { on: false, start: 0, len: 0 },
  crop: { on: false, shape: '169', pos: 'c' },
  rotate: { on: false, turn: '90', flip: 'none' },
  smooth: { on: false, strength: 70, dropOdd: true },
  fps: { on: false, target: 60, engine: 'blend', model: 'rife-v4.6', gpu: 0, loop: true, fix: true },
  slow: { on: false, factor: 2, mode: 'slow', engine: 'blend', model: 'rife-v4.6', gpu: 0 },
  up: { on: false, scale: 2, sharp: 50, engine: 'sharp', model: 'realesr-animevideov3', gpu: 0 },
  size: { on: false, box: '1920x1080', fit: 'keep', upscale: false },
  look: { on: false, id: 'sepia', ids: ['sepia'], keepOriginal: false, amount: 50 },
  life: { on: false, style: 'calm', ...LIFE_STYLES.calm, minSeconds: 16 },
  kb: { on: false, mode: 'zoomin', amount: 50, ret: true, minSeconds: 24 },
  loop: { on: false, mode: 'auto', fade: 1.5, fallback: 'pingpong' },
  out: { fps: 0, crf: 18, minSeconds: 0, keepAudio: false },
});
export const mergeRecipe = (R, patch) => { for (const k of Object.keys(patch)) { R[k] = { ...R[k], ...patch[k] }; if (k !== 'out') R[k].on = true; } return R; };

// The full plan for one clip: filters in order cut → rotate → crop → slow → upscale → resize → look, then encode, then optional loop smoothing.
export function planRecipe(info, R, baseProf) {
  const pre = [], notes = [];
  let w = info.width, h = info.height, dur = info.duration || 0, fps = 0;
  const seek = R.cut.on ? Math.max(0, +R.cut.start || 0) : 0; let limit = R.cut.on ? Math.max(0, +R.cut.len || 0) : 0;   // the limit is counted on the result, so slow motion stretches it
  if (R.cut.on) {
    if (dur && seek >= dur - 0.05) throw new Error('The start time is after the end of this clip');
    dur = Math.min(dur - seek, limit || Infinity); notes.push(`cut ${seek ? 'from ' + seek + ' s' : ''}${limit ? ' ' + limit + ' s' : ''}`.trim());
  }
  if (R.rotate.on) {
    const ro = rotatePlan({ width: w, height: h }, R.rotate);
    if (ro.filter) { pre.push(ro.filter); w = ro.width; h = ro.height; notes.push('rotated'); }
  }
  if (R.crop.on && R.crop.shape !== 'none') {
    const cr = cropFor({ ...info, width: w, height: h }, R.crop.shape, R.crop.pos);
    if (cr.filter) { pre.push(cr.filter); w = cr.width; h = cr.height; notes.push(`${w}×${h}`); }
  }
  if (R.slow.on) {
    const sp = slowPlan({ ...info, fps: info.fps || 25 }, R.slow);
    if (sp.pre) { pre.push(sp.pre); dur *= sp.durMul; limit *= sp.durMul; if (sp.fps) fps = sp.fps; notes.push(sp.note); }
  }
  const lifeAt = pre.length;   // the slow-in-and-out time remap goes here, before the picture is resized
  if (R.up.on) {
    const up = upscalePlan({ width: w, height: h }, R.up.scale, R.up.sharp);
    pre.push(up.filter); w = up.width; h = up.height; notes.push(`${R.up.scale}× bigger`);
  }
  const prof = { ...baseProf, fps: fps || +R.out.fps || 0, crf: R.out.crf, minSeconds: Math.max(+R.out.minSeconds || 0, (R.life && R.life.on) ? +R.life.minSeconds || 0 : 0, (R.kb && R.kb.on) ? +R.kb.minSeconds || 0 : 0), keepAudio: !!R.out.keepAudio && !R.slow.on && !(R.smooth && R.smooth.on), maxFps: 60 };
  let lifeP = null;
  if (R.life && R.life.on) {
    lifeP = lifePlan({ duration: dur, fps: info.fps || 25 }, R.life, { minSeconds: prof.minSeconds, repeatAfter: !!R.loop.on, outFps: chooseFps({ ...info, fps: info.fps || 25 }, prof) });
    if (lifeP.pre) pre.splice(lifeAt, 0, lifeP.pre); notes.push(...lifeP.notes);
  }
  if (R.size.on) { prof.size = R.size.box; prof.fit = R.size.fit; prof.upscale = !!R.size.upscale; }
  else { prof.size = `${w}x${h}`; prof.fit = 'keep'; prof.upscale = false; }
  const cur = { ...info, width: w, height: h, duration: dur };
  const [tw, th] = targetSize(cur, prof);
  let kbP = null;
  if (R.kb && R.kb.on) {
    kbP = kenPlan({ duration: dur, fps: info.fps || 25 }, R.kb, { minSeconds: prof.minSeconds, repeatAfter: !!R.loop.on, outFps: chooseFps({ ...info, fps: info.fps || 25 }, prof) });
    notes.push(...kbP.notes);
  }
  const extra = [kbP && kbP.extra, lifeP && lifeP.extra, R.look.on ? filterChain(R.look.id, +R.look.amount, { w: tw, h: th, dur }) : ''].filter(Boolean).join(',');
  if (R.look.on) notes.push(`look ${R.look.id}`);
  return { pre: pre.join(','), seek, limit, prof, cur, extra, size: [tw, th], notes, duration: dur };
}

// Run the plan: one ffmpeg pass, then loop smoothing when asked. loops = the loops.js module. Returns { note }.
// ---------------------------------------------------------------------------------------------- AI steps (Video2X, Linux local version)
export const v2xReady = engine => !!(engine && engine.kind === 'native' && engine.info && engine.info.v2x && engine.info.v2x.ok && engine.v2x);
export const wantsAi = R => !!((R.slow.on && R.slow.engine === 'ai') || (R.up.on && R.up.engine === 'ai') || (R.fps && R.fps.on && R.fps.engine === 'ai'));
const clone = o => JSON.parse(JSON.stringify(o));
const errLine = (r, re) => (r.log.filter(l => re.test(l)).slice(-1)[0] || 'code ' + r.code).slice(0, 160);

// AI stages run first, each as its own pass: [cut, rotate, crop, soft slow motion] -> AI slow motion -> AI upscale. What is left
// (look, life, size, loop, repeat) goes through the normal pass afterwards. Returns { path, info, R, notes, tmps }.
async function aiStages(engine, loops, src, info, R, baseProf, ctl, report, onStage, tag) {
  const tmps = [], notes = [], v = engine.info.v2x, aiSlow = R.slow.on && R.slow.engine === 'ai', aiUp = R.up.on && R.up.engine === 'ai', aiFps = !!(R.fps && R.fps.on && R.fps.engine === 'ai');
  const R3 = clone(R), pre = clone(R);
  let path = src, cur = info, done = 0;
  const W = { a: 1, ai: 6, fin: 2 }, usesA = R.cut.on || R.rotate.on || R.crop.on || (R.slow.on && !aiSlow);
  const total = (usesA ? W.a : 0) + (aiSlow ? W.ai : 0) + (aiFps ? W.ai : 0) + (aiUp ? W.ai : 0) + W.fin;
  const rep = (w, x) => { lastP = Math.min(1, x); report && report((done + w * Math.min(1, x)) / total); };
  const finish = w => { done += w; };
  let dev = null, lastP = 0;
  const tick = kind => { const t0 = Date.now(); lastP = 0; const send = () => { const sec = Math.round((Date.now() - t0) / 1000); onStage && onStage(kind, sec, { p: lastP, eta: lastP > .03 ? sec * (1 - lastP) / lastP : null, gpu: dev && dev.name, soft: !!(dev && dev.soft) }); }; send(); return setInterval(send, 1000); };
  const card = async () => dev || (dev = await aiDevice(engine, +R.up.gpu || +R.slow.gpu || +(R.fps && R.fps.gpu) || 0));
  // pass A: plain ffmpeg work that comes before the AI, kept near lossless
  if (usesA) {
    pre.up.on = false; pre.fps.on = false; pre.kb.on = false; pre.smooth.on = false; pre.life.on = false; pre.look.on = false; pre.loop.on = false; pre.size.on = false; pre.out = { ...pre.out, crf: 12, minSeconds: 0, fps: 0, keepAudio: false };
    if (aiSlow) pre.slow.on = false;
    const pa = planRecipe(info, pre, { ...baseProf, maxMBps: 0, preset: 'veryfast' }), out = `${tag}_a.mp4`; tmps.push(out);
    ctl.check();
    const r = await engine.exec(encodeArgs(src, out, { ...pa.prof, crf: 12, minSeconds: 0, maxMBps: 0, preset: 'veryfast' }, pa.cur, { pre: pa.pre, seek: pa.seek, limit: pa.limit, repeat: 1 }), { onProgress: x => rep(W.a, x) });
    if (r.code !== 0) throw new Error('Could not prepare this clip (' + errLine(r, /error|invalid|not supported|unknown|no such/i) + ')');
    finish(W.a); path = out; cur = await loops.probe(engine, out);
    R3.cut.on = false; R3.rotate.on = false; R3.crop.on = false; if (R.slow.on && !aiSlow) R3.slow.on = false;
  }
  if (aiSlow) {
    const m = Math.min(8, Math.max(2, Math.round(+R.slow.factor) || 2)), smooth = R.slow.mode === 'smooth', fps = cur.fps || 25;
    if (smooth && fps * m > 120) throw new Error('The result would have more than 120 frames per second. Choose a smaller number, or slow motion instead.');
    const out = `${tag}_s.mp4`; tmps.push(out); ctl.check();
    await card(); const t = tick('slow');
    let r; try { r = await engine.v2x(['-i', path, '-o', out, '-p', 'rife', '--rife-model', R.slow.model || 'rife-v4.6', v.mul || '-m', String(m), '-c', 'libx264', '-e', 'preset=veryfast', '-e', 'crf=14', ...dev.args], { onProgress: x => rep(W.ai, x) }); } finally { clearInterval(t); }
    if (r.code !== 0) throw new Error('Could not make slow motion of this file (' + errLine(r, /error|invalid|fail|not supported|unknown|vulkan|rife/i) + ')');
    finish(W.ai); path = out;
    if (!smooth) {   // the new frames play at the old speed: stretch the time stamps without encoding again (the sound would no longer fit)
      const o2 = `${tag}_s2.mp4`; tmps.push(o2);
      const r2 = await engine.exec(['-y', '-itsscale', String(m), '-i', path, '-an', '-c', 'copy', '-movflags', '+faststart', o2], {});
      if (r2.code !== 0) throw new Error('Could not make slow motion of this file (' + errLine(r2, /error|invalid|not supported|unknown/i) + ')');
      path = o2;
    }
    cur = await loops.probe(engine, path); R3.slow.on = false; notes.push(smooth ? `AI smoother, ${m}× frames` : `AI slow motion ${m}× slower`);
  }
  if (aiFps) {   // AI frame rate: RIFE makes whole-number multiples of the frames, then a blend lands exactly on the target
    const F = cur.fps || 25, Tg = +R.fps.target || 60; R3.fps.on = false;
    if (F >= Tg - 0.5) { notes.push(`already ${Math.round(F)} fps`); finish(W.ai); }
    else {
      const m = Math.min(8, Math.max(2, Math.ceil(Tg / F - 0.01))); ctl.check();
      const g = await loops.grayFrames(engine, path, F), pl = fpsPlan(g.data, g.n, F, { target: Tg, engine: 'ai', loop: R.fps.loop !== false, fix: false }), N = g.n, M = Math.round(N / F * Tg);
      let inp = path;
      if (pl.wrap) {   // the first frame is added at the end, so the AI also makes the frames across the loop seam
        const w = `${tag}_fw.mp4`; tmps.push(w);
        const rw = await engine.exec(['-y', '-i', path, '-an', '-filter_complex', `[0:v]split[a][b];[b]trim=end_frame=1,setpts=PTS-STARTPTS[c];[a][c]concat=n=2:v=1:a=0[o]`, '-map', '[o]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(F), '-fps_mode', 'cfr', w]);
        if (rw.code !== 0) throw new Error('Could not prepare this clip (' + errLine(rw, /error|invalid|not supported|unknown/i) + ')');
        inp = w;
      }
      const out = `${tag}_f.mp4`; tmps.push(out); await card(); const t = tick('fps');
      let r; try { r = await engine.v2x(['-i', inp, '-o', out, '-p', 'rife', '--rife-model', R.fps.model || 'rife-v4.6', v.mul || '-m', String(m), '-c', 'libx264', '-e', 'preset=veryfast', '-e', 'crf=14', ...dev.args], { onProgress: x => rep(W.ai, x) }); } finally { clearInterval(t); }
      if (r.code !== 0) throw new Error('Could not change the frame rate of this file (' + errLine(r, /error|invalid|fail|not supported|unknown|vulkan|rife/i) + ')');
      finish(W.ai); path = out;
      if (pl.wrap || Math.abs(F * m - Tg) > 0.05) {   // land on the target and cut to exactly the length of the clip
        const o2 = `${tag}_f2.mp4`; tmps.push(o2);
        const r2 = await engine.exec(['-y', '-i', path, '-an', ...(Math.abs(F * m - Tg) > 0.05 ? ['-vf', `framerate=fps=${Tg}:interp_start=0:interp_end=255:scene=100`] : []), ...(pl.wrap ? ['-frames:v', String(M)] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(Tg), '-fps_mode', 'cfr', o2]);
        if (r2.code !== 0) throw new Error('Could not change the frame rate of this file (' + errLine(r2, /error|invalid|not supported|unknown/i) + ')');
        path = o2;
      }
      cur = await loops.probe(engine, path); notes.push(`AI ${Math.round(F * 100) / 100} → ${Tg} fps${pl.wrap ? ', loop seam kept' : ''}`);
    }
  }
  if (aiUp) {
    const plus = R.up.model === 'realesrgan-plus', sc = plus ? 4 : Math.min(4, Math.max(2, Math.round(+R.up.scale) || 2)), a4k = R.up.model === 'anime4k';
    if (cur.width * sc > 7680 || cur.height * sc > 7680) throw new Error('The result would be larger than 8K. Choose a smaller scale or a smaller clip.');
    const out = `${tag}_u.mp4`; tmps.push(out); ctl.check();
    const model = a4k ? ['-p', 'libplacebo', '--libplacebo-shader', 'anime4k-v4-a+a', '-w', String(even(cur.width * sc)), '-h', String(even(cur.height * sc))] : ['-p', 'realesrgan', '--realesrgan-model', R.up.model || 'realesr-animevideov3', '-s', String(sc)];
    await card(); const t = tick('up');
    let r; try { r = await engine.v2x(['-i', path, '-o', out, ...model, '-c', 'libx264', '-e', 'preset=veryfast', '-e', 'crf=14', ...dev.args], { onProgress: x => rep(W.ai, x) }); } finally { clearInterval(t); }
    if (r.code !== 0) throw new Error('Could not upscale this file (' + errLine(r, /error|invalid|fail|not supported|unknown|vulkan/i) + ')');
    finish(W.ai); path = out; notes.push(`AI ${sc}× bigger`); R3.up.on = false;
    cur = await loops.probe(engine, path);
  }
  return { path, info: cur, R: R3, notes, tmps, rest: W.fin / total, base: done / total };
}

// Smooth out and Frame rate run first, as their own passes: [cut] -> [look at the movement and retime] -> [make the new frames]. The rest of the
// recipe then works on the result. (AI frame rate is done in aiStages, which also needs the Video2X engine.)
async function timeStage(engine, loops, src, info, R, baseProf, ctl, report, tag) {
  const doS = !!(R.smooth && R.smooth.on), doF = !!(R.fps && R.fps.on && R.fps.engine !== 'ai'), usesCut = !!R.cut.on;
  const tmps = [], W = { cut: 1, look: 1, enc: 6, fin: 3 }, total = (usesCut ? W.cut : 0) + (doS ? W.look + W.enc : 0) + (doF ? W.look + W.enc : 0) + W.fin, notes = [];
  let done = 0, path = src, cur = info;
  const rep = (w, x) => report && report((done + w * Math.min(1, x)) / total);
  const R3 = clone(R); R3.smooth.on = false; if (doF) R3.fps.on = false;
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', '30'];
  const fail = (what, r) => new Error(`Could not ${what} (` + errLine(r, /error|invalid|not supported|unknown|no such/i) + ')');
  if (usesCut) {
    const pre = clone(R); for (const k of ['crop', 'rotate', 'slow', 'up', 'size', 'look', 'life', 'kb', 'loop', 'smooth', 'fps']) if (pre[k]) pre[k].on = false;
    pre.out = { ...pre.out, crf: 12, minSeconds: 0, fps: 0, keepAudio: false };
    const pa = planRecipe(info, pre, { ...baseProf, maxMBps: 0, preset: 'veryfast' }), out = `${tag}_c.mp4`; tmps.push(out); ctl.check();
    const r = await engine.exec(encodeArgs(src, out, { ...pa.prof, crf: 12, minSeconds: 0, maxMBps: 0, preset: 'veryfast' }, pa.cur, { pre: pa.pre, seek: pa.seek, limit: pa.limit, repeat: 1 }), { onProgress: x => rep(W.cut, x) });
    if (r.code !== 0) throw fail('prepare this clip', r);
    done += W.cut; path = out; cur = await loops.probe(engine, out); R3.cut.on = false;
  }
  if (doS) {
    const fps = chooseFps({ ...cur, fps: cur.fps || 25 }, { fps: 0, maxFps: 60 }); ctl.check();
    const g = await loops.grayFrames(engine, path, fps); done += W.look; report && report(done / total); ctl.check();
    const plan = smoothPlan(g.data, g.n, fps, { strength: Math.max(0, Math.min(100, +R.smooth.strength || 0)) / 100, dropOdd: R.smooth.dropOdd !== false });
    if (!plan.changed) { done += W.enc; notes.push('already even'); }
    else {
      const out = `${tag}_sm.mp4`; tmps.push(out); ctl.check();
      const r = await engine.exec(['-y', '-i', path, '-an', '-vf', smoothChain(plan, fps), ...enc, '-r', String(fps), '-fps_mode', 'cfr', '-movflags', '+faststart', out], { onProgress: x => rep(W.enc, x) });
      if (r.code !== 0) throw fail('smooth this clip', r);
      done += W.enc; path = out; cur = await loops.probe(engine, out); notes.push(plan.drop.length ? 'smoothed, stray frames removed' : 'smoothed');
    }
  }
  if (doF) {
    const F = cur.fps || 25; ctl.check();
    const g = await loops.grayFrames(engine, path, F); done += W.look; report && report(done / total); ctl.check();
    const pl = fpsPlan(g.data, g.n, F, { target: +R.fps.target || 60, engine: R.fps.engine, loop: R.fps.loop !== false, fix: R.fps.fix !== false });
    if (pl.skip) { done += W.enc; notes.push(pl.note); }
    else {
      const out = `${tag}_fr.mp4`; tmps.push(out); ctl.check();
      const args = ['-y', ...(pl.wrap ? ['-stream_loop', '1'] : []), '-i', path, '-an', '-vf', pl.chain, ...(pl.wrap ? ['-frames:v', String(pl.outFrames)] : []), ...enc, '-g', String(Math.round(pl.target)), '-r', String(pl.target), '-fps_mode', 'cfr', '-movflags', '+faststart', out];
      Object.defineProperty(args, 'expect', { value: pl.outFrames / pl.target, enumerable: false });
      const r = await engine.exec(args, { onProgress: x => rep(W.enc, x) });
      if (r.code !== 0) throw fail('change the frame rate of this clip', r);
      done += W.enc; path = out; cur = await loops.probe(engine, out); notes.push(pl.note);
    }
  }
  return { path, info: cur, R: R3, notes, tmps, base: done / total, rest: W.fin / total };
}

export async function runRecipe(engine, loops, src, dst, info, R, baseProf, { ctl = { check() {} }, onProgress, onStage, tmp = 'hosp_tmp.mp4' } = {}) {
  if ((R.smooth && R.smooth.on) || (R.fps && R.fps.on && R.fps.engine !== 'ai')) {
    const st = await timeStage(engine, loops, src, info, R, baseProf, ctl, onProgress, tmp.replace(/\.mp4$/, '') + '_sm');
    try {
      const r = await runRecipe(engine, loops, st.path, dst, st.info, st.R, baseProf, { ctl, onProgress: onProgress && (x => onProgress(st.base + st.rest * x)), onStage, tmp });
      return { ...r, note: [...st.notes, r.note].filter(Boolean).join(', ') };
    } finally { for (const t of st.tmps) { try { await engine.remove(t); } catch (e) { /* ignore */ } } }
  }
  if (wantsAi(R)) {
    if (!v2xReady(engine)) throw new Error('AI needs the Linux (local) version with Video2X installed. Choose another method.');
    const tag = tmp.replace(/\.mp4$/, '') + '_ai', st = await aiStages(engine, loops, src, info, R, baseProf, ctl, onProgress, onStage, tag);
    try {
      const r = await runRecipe(engine, loops, st.path, dst, st.info, st.R, baseProf, { ctl, onProgress: onProgress && (x => onProgress(st.base + st.rest * x)), onStage, tmp });
      return { ...r, note: [...st.notes, r.note].filter(Boolean).join(', ') };
    } finally { for (const t of st.tmps) { try { await engine.remove(t); } catch (e) { /* ignore */ } } }
  }
  const p = planRecipe(info, R, baseProf);
  const passes = R.loop.on ? 2 : 1, prog = (i, f) => f && (x => f((i + Math.min(1, x)) / passes));
  const args = encodeArgs(src, R.loop.on ? tmp : dst, R.loop.on ? { ...p.prof, crf: 14, preset: 'veryfast', minSeconds: 0 } : p.prof, p.cur, { pre: p.pre, extra: p.extra, seek: p.seek, limit: p.limit, repeat: R.loop.on ? 1 : repeatsNeeded(p.duration, p.prof.minSeconds) });   // with the loop step on, makeLoop does the repeating
  const r = await engine.exec(args, { onProgress: prog(0, onProgress) });
  if (r.code !== 0) throw new Error('Could not treat this clip (' + (r.log.filter(l => /error|invalid|not supported|unknown|no such/i.test(l)).slice(-1)[0] || 'code ' + r.code).slice(0, 160) + ')');
  ctl.check();
  let note = p.notes.join(', ');
  if (R.loop.on) {
    try {
      const li = await loops.probe(engine, tmp);
      const lp = { ...p.prof, size: `${p.size[0]}x${p.size[1]}`, fit: 'keep', upscale: false, fps: 0, crf: R.out.crf, minSeconds: R.out.minSeconds };
      const lr = await loops.makeLoop(engine, tmp, dst, lp, li, { mode: R.loop.mode, fade: R.loop.fade, fallback: R.loop.fallback || 'pingpong', ctl, onProgress: prog(1, onProgress) });
      note += (note ? '; ' : '') + lr.note;
    } finally { await engine.remove(tmp); }
  }
  return { note, plan: p };
}
