// Treatment steps shared by the Tools page and the Loop Hospital.
// Each helper returns a piece of an ffmpeg filter graph (no AI needed, works in the browser too).
import { encodeArgs, cropFor, chooseFps, targetSize, repeatsNeeded, v2xVbvArgs } from './core.js';
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

// ---------------------------------------------------------------------------------------------- "Bring it to life": organic motion for still loops
// Everything here is periodic over a whole number of loop lengths, so the result still loops without a seam.
//   ease    slow in and out: the clip lingers around the loop point and glides through the middle (speed changes, length does not)
//   breathe a slow zoom in and out        drift  a floating sideways/up-down movement      sway  a very small tilt
//   glow    brightness and colour breathing                                              trails  soft ghosts of the last frames
export const LIFE_STYLES = {
  calm:   { ease: 60, breathe: 35, drift: 0,  sway: 0,  glow: 0,  trails: false },
  float:  { ease: 40, breathe: 25, drift: 60, sway: 40, glow: 0,  trails: false },
  dream:  { ease: 70, breathe: 40, drift: 40, sway: 25, glow: 35, trails: true },
  pulse:  { ease: 30, breathe: 55, drift: 0,  sway: 0,  glow: 60, trails: false },
};
export function lifePeriod(D, minSeconds, repeatAfter) {      // one "breath" lasts a whole number of loop lengths that fits into the final length
  if (!(D > 0)) return { P: 8, n: 1, T: 0 };
  const n = repeatAfter ? 1 : repeatsNeeded(D, minSeconds || 0);
  let m = 1; for (let k = n; k >= 1; k--) if (n % k === 0 && D * k <= 12) { m = k; break; }
  return { P: D * m, n, T: D * n };
}
export function lifePlan(info, L, { minSeconds = 0, repeatAfter = false, outFps = 0 } = {}) {
  const D = info.duration || 0, F = info.fps || 25, OF = outFps || F, c = v => Math.max(0, Math.min(100, +v || 0)) / 100, { P, T } = lifePeriod(D, minSeconds, repeatAfter);
  const ease = c(L.ease), breathe = c(L.breathe), drift = c(L.drift), sway = c(L.sway), glow = c(L.glow), notes = [];
  let pre = '', extra = []; const f = v => String(Math.round(v * 10000) / 10000);
  if (ease > 0 && D > 0) {       // time stretches by (1 + a·cos) around the loop point: slow at the start and end, faster in the middle
    const a = f(ease * 0.85), A = f(ease * 0.85 * D / (2 * Math.PI));
    pre = `${F <= 31 ? `framerate=fps=${f(F * 2)},` : ''}setpts='PTS+${A}*sin(2*PI*PTS*TB/${f(D)})/TB'`; notes.push('slow in and out');
  }
  if (breathe > 0 || drift > 0 || sway > 0) {
    const zA = breathe * 0.10, dA = drift * 0.03, th = sway * 0.015, marg = Math.min(0.35, 2 * dA + 3.6 * th + 0.006), s0 = 1 / (1 - marg);
    const p1 = `(2*PI*on/${f(P * OF)})`, S = `(${f(s0)}+${f(zA)}*(0.5-0.5*cos(${p1})))`;
    const cx = `(W/2+W*${f(dA)}*(sin(${p1}+0.7)+0.5*sin(2*${p1}+2.1))/1.5)`, cy = `(H/2+H*${f(dA * 0.7)}*(cos(${p1}+1.3)+0.5*sin(2*${p1}+0.4))/1.5)`;
    const t = `(${f(th)}*sin(${p1}+2))`, hw = `(W/(2*${S}))`, hh = `(H/(2*${S}))`;
    const q = e => `'${e}'`;
    extra.push(`perspective=eval=frame:sense=source:interpolation=cubic:x0=${q(`${cx}-${hw}+${hh}*${t}`)}:y0=${q(`${cy}-${hw}*${t}-${hh}`)}:x1=${q(`${cx}+${hw}+${hh}*${t}`)}:y1=${q(`${cy}+${hw}*${t}-${hh}`)}:x2=${q(`${cx}-${hw}-${hh}*${t}`)}:y2=${q(`${cy}-${hw}*${t}+${hh}`)}:x3=${q(`${cx}+${hw}-${hh}*${t}`)}:y3=${q(`${cy}+${hw}*${t}+${hh}`)}`);
    if (breathe > 0) notes.push('breathing zoom'); if (drift > 0) notes.push('floating'); if (sway > 0) notes.push('gentle tilt');
  }
  if (glow > 0) { extra.push(`eq=brightness='${f(0.05 * glow)}*sin(2*PI*t/${f(P)})':saturation='1+${f(0.25 * glow)}*sin(2*PI*t/${f(P)}+1.1)':eval=frame`); notes.push('light breathing'); }
  if (L.trails) { extra.push(`tmix=frames=4:weights='4 3 2 1'`); notes.push('soft trails'); }
  return { pre, extra: extra.join(','), notes, period: P, total: T };
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
  slow: { on: false, factor: 2, mode: 'slow', engine: 'blend', model: 'rife-v4.6' },
  up: { on: false, scale: 2, sharp: 50, engine: 'sharp', model: 'realesr-animevideov3' },
  size: { on: false, box: '1920x1080', fit: 'keep', upscale: false },
  look: { on: false, id: 'sepia', ids: ['sepia'], keepOriginal: false, amount: 50 },
  life: { on: false, style: 'calm', ...LIFE_STYLES.calm, minSeconds: 16 },
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
  const prof = { ...baseProf, fps: fps || +R.out.fps || 0, crf: R.out.crf, minSeconds: (R.life && R.life.on) ? Math.max(+R.out.minSeconds || 0, +R.life.minSeconds || 0) : R.out.minSeconds, keepAudio: !!R.out.keepAudio && !R.slow.on, maxFps: 60 };
  let lifeP = null;
  if (R.life && R.life.on) {
    lifeP = lifePlan({ duration: dur, fps: info.fps || 25 }, R.life, { minSeconds: prof.minSeconds, repeatAfter: !!R.loop.on, outFps: chooseFps({ ...info, fps: info.fps || 25 }, prof) });
    if (lifeP.pre) pre.splice(lifeAt, 0, lifeP.pre); notes.push(...lifeP.notes);
  }
  if (R.size.on) { prof.size = R.size.box; prof.fit = R.size.fit; prof.upscale = !!R.size.upscale; }
  else { prof.size = `${w}x${h}`; prof.fit = 'keep'; prof.upscale = false; }
  const cur = { ...info, width: w, height: h, duration: dur };
  const [tw, th] = targetSize(cur, prof);
  const extra = [lifeP && lifeP.extra, R.look.on ? filterChain(R.look.id, +R.look.amount, { w: tw, h: th, dur }) : ''].filter(Boolean).join(',');
  if (R.look.on) notes.push(`look ${R.look.id}`);
  return { pre: pre.join(','), seek, limit, prof, cur, extra, size: [tw, th], notes, duration: dur };
}

// Run the plan: one ffmpeg pass, then loop smoothing when asked. loops = the loops.js module. Returns { note }.
// ---------------------------------------------------------------------------------------------- AI steps (Video2X, Linux local version)
export const v2xReady = engine => !!(engine && engine.kind === 'native' && engine.info && engine.info.v2x && engine.info.v2x.ok && engine.v2x);
export const wantsAi = R => !!((R.slow.on && R.slow.engine === 'ai') || (R.up.on && R.up.engine === 'ai'));
const clone = o => JSON.parse(JSON.stringify(o));
const errLine = (r, re) => (r.log.filter(l => re.test(l)).slice(-1)[0] || 'code ' + r.code).slice(0, 160);

// AI stages run first, each as its own pass: [cut, rotate, crop, soft slow motion] -> AI slow motion -> AI upscale. What is left
// (look, life, size, loop, repeat) goes through the normal pass afterwards. Returns { path, info, R, notes, tmps }.
async function aiStages(engine, loops, src, info, R, baseProf, ctl, report, onStage, tag) {
  const tmps = [], notes = [], v = engine.info.v2x, aiSlow = R.slow.on && R.slow.engine === 'ai', aiUp = R.up.on && R.up.engine === 'ai';
  const R3 = clone(R), pre = clone(R);
  let path = src, cur = info, done = 0;
  const W = { a: 1, ai: 6, fin: 2 }, usesA = R.cut.on || R.rotate.on || R.crop.on || (R.slow.on && !aiSlow);
  const total = (usesA ? W.a : 0) + (aiSlow ? W.ai : 0) + (aiUp ? W.ai : 0) + W.fin;
  const rep = (w, x) => report && report((done + w * Math.min(1, x)) / total);
  const finish = w => { done += w; };
  const tick = kind => { const t0 = Date.now(); onStage && onStage(kind, 0); return setInterval(() => onStage && onStage(kind, Math.round((Date.now() - t0) / 1000)), 1000); };
  // pass A: plain ffmpeg work that comes before the AI, kept near lossless
  if (usesA) {
    pre.up.on = false; pre.life.on = false; pre.look.on = false; pre.loop.on = false; pre.size.on = false; pre.out = { ...pre.out, crf: 12, minSeconds: 0, fps: 0, keepAudio: false };
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
    const t = tick('slow');
    let r; try { r = await engine.v2x(['-i', path, '-o', out, '-p', 'rife', '--rife-model', R.slow.model || 'rife-v4.6', v.mul || '-m', String(m), '-c', 'libx264', '-e', 'crf=14'], { onProgress: x => rep(W.ai, x) }); } finally { clearInterval(t); }
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
  if (aiUp) {
    const plus = R.up.model === 'realesrgan-plus', sc = plus ? 4 : Math.min(4, Math.max(2, Math.round(+R.up.scale) || 2)), a4k = R.up.model === 'anime4k';
    if (cur.width * sc > 7680 || cur.height * sc > 7680) throw new Error('The result would be larger than 8K. Choose a smaller scale or a smaller clip.');
    const out = `${tag}_u.mp4`; tmps.push(out); ctl.check();
    const model = a4k ? ['-p', 'libplacebo', '--libplacebo-shader', 'anime4k-v4-a+a', '-w', String(even(cur.width * sc)), '-h', String(even(cur.height * sc))] : ['-p', 'realesrgan', '--realesrgan-model', R.up.model || 'realesr-animevideov3', '-s', String(sc)];
    const t = tick('up');
    let r; try { r = await engine.v2x(['-i', path, '-o', out, ...model, '-c', 'libx264', '-e', 'crf=14'], { onProgress: x => rep(W.ai, x) }); } finally { clearInterval(t); }
    if (r.code !== 0) throw new Error('Could not upscale this file (' + errLine(r, /error|invalid|fail|not supported|unknown|vulkan/i) + ')');
    finish(W.ai); path = out; notes.push(`AI ${sc}× bigger`); R3.up.on = false;
    cur = await loops.probe(engine, path);
  }
  return { path, info: cur, R: R3, notes, tmps, rest: W.fin / total, base: done / total };
}

export async function runRecipe(engine, loops, src, dst, info, R, baseProf, { ctl = { check() {} }, onProgress, onStage, tmp = 'hosp_tmp.mp4' } = {}) {
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
