// Treatment steps shared by the Tools page and the Loop Hospital.
// Each helper returns a piece of an ffmpeg filter graph (no AI needed, works in the browser too).
import { encodeArgs, cropFor, chooseFps, targetSize } from './core.js';
import { filterChain } from './filters.js';

const r3 = v => Math.round(v * 1000) / 1000;
export const even = v => Math.max(2, Math.round(v / 2) * 2);

// Sharp upscale: Lanczos resize followed by a gentle sharpening. sharp = 0..100
export function upscalePlan(info, scale, sharp = 50) {
  const s = Math.max(1, +scale || 2), w = even(info.width * s), h = even(info.height * s);
  const amt = Math.round(Math.max(0, Math.min(100, +sharp || 0)) * 1.5) / 100;
  return { filter: `scale=${w}:${h}:flags=lanczos` + (amt > 0 ? `,unsharp=5:5:${amt}:5:5:0` : ''), width: w, height: h };
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

// What is wrong with this clip, and what would help? info: probe result, loop: loop report (or null)
export function diagnose(info, loop, { want = 1080 } = {}) {
  const out = [];
  const short = Math.min(info.width, info.height);
  if (info.width && short < 720) out.push({ id: 'small', text: `Small picture (${info.width}×${info.height}). It will look soft on a big screen.`, fix: { up: { on: true, scale: short < 400 ? 4 : 2 } } });
  if (info.duration && info.duration < 4) out.push({ id: 'short', text: `Very short (${Math.round(info.duration * 10) / 10} s). Slow motion makes it longer and calmer.`, fix: { slow: { on: true, factor: 2 } } });
  else if (info.fps && info.fps < 20) out.push({ id: 'lowfps', text: `Low frame rate (${Math.round(info.fps)} fps). Smooth mode adds frames.`, fix: { slow: { on: true, factor: 2, mode: 'smooth' } } });
  if (loop && loop.verdict && loop.verdict !== 'seamless') out.push({ id: 'jump', text: loop.verdict === 'almost' ? 'The loop point is almost clean. A small fix will hide the jump.' : 'You can see a jump where the clip starts over.', fix: { loop: { mode: 'auto' } } });
  if (info.hasAudio) out.push({ id: 'audio', text: 'This clip has sound. The treated clip will be silent, which suits loops for mixing.', fix: {} });
  if (info.isGif) out.push({ id: 'gif', text: 'A GIF. It will become a smooth mp4.', fix: {} });
  return out;
}

export const defaultRecipe = () => ({
  cut: { on: false, start: 0, len: 0 },
  crop: { on: false, shape: '169', pos: 'c' },
  slow: { on: false, factor: 2, mode: 'slow', engine: 'blend' },
  up: { on: false, scale: 2, sharp: 50 },
  size: { on: false, box: '1920x1080', fit: 'keep', upscale: false },
  look: { on: false, id: 'sepia', amount: 50 },
  loop: { on: false, mode: 'auto', fade: 1.5, fallback: 'pingpong' },
  out: { fps: 0, crf: 18, minSeconds: 0, keepAudio: false },
});
export const mergeRecipe = (R, patch) => { for (const k of Object.keys(patch)) { R[k] = { ...R[k], ...patch[k] }; if (k !== 'out') R[k].on = true; } return R; };

// The full plan for one clip: filters in order cut → crop → slow → upscale → resize → look, then encode, then optional loop smoothing.
export function planRecipe(info, R, baseProf) {
  const pre = [], notes = [];
  let w = info.width, h = info.height, dur = info.duration || 0, fps = 0;
  const seek = R.cut.on ? Math.max(0, +R.cut.start || 0) : 0; let limit = R.cut.on ? Math.max(0, +R.cut.len || 0) : 0;   // the limit is counted on the result, so slow motion stretches it
  if (R.cut.on) {
    if (dur && seek >= dur - 0.05) throw new Error('The start time is after the end of this clip');
    dur = Math.min(dur - seek, limit || Infinity); notes.push(`cut ${seek ? 'from ' + seek + ' s' : ''}${limit ? ' ' + limit + ' s' : ''}`.trim());
  }
  if (R.crop.on && R.crop.shape !== 'none') {
    const cr = cropFor({ ...info, width: w, height: h }, R.crop.shape, R.crop.pos);
    if (cr.filter) { pre.push(cr.filter); w = cr.width; h = cr.height; notes.push(`${w}×${h}`); }
  }
  if (R.slow.on) {
    const sp = slowPlan({ ...info, fps: info.fps || 25 }, R.slow);
    if (sp.pre) { pre.push(sp.pre); dur *= sp.durMul; limit *= sp.durMul; if (sp.fps) fps = sp.fps; notes.push(sp.note); }
  }
  if (R.up.on) {
    const up = upscalePlan({ width: w, height: h }, R.up.scale, R.up.sharp);
    pre.push(up.filter); w = up.width; h = up.height; notes.push(`${R.up.scale}× bigger`);
  }
  const prof = { ...baseProf, fps: fps || +R.out.fps || 0, crf: R.out.crf, minSeconds: R.out.minSeconds, keepAudio: !!R.out.keepAudio && !R.slow.on, maxFps: 60 };
  if (R.size.on) { prof.size = R.size.box; prof.fit = R.size.fit; prof.upscale = !!R.size.upscale; }
  else { prof.size = `${w}x${h}`; prof.fit = 'keep'; prof.upscale = false; }
  const cur = { ...info, width: w, height: h, duration: dur };
  const [tw, th] = targetSize(cur, prof);
  const extra = R.look.on ? filterChain(R.look.id, +R.look.amount, { w: tw, h: th, dur }) : '';
  if (R.look.on) notes.push(`look ${R.look.id}`);
  return { pre: pre.join(','), seek, limit, prof, cur, extra, size: [tw, th], notes, duration: dur };
}

// Run the plan: one ffmpeg pass, then loop smoothing when asked. loops = the loops.js module. Returns { note }.
export async function runRecipe(engine, loops, src, dst, info, R, baseProf, { ctl = { check() {} }, onProgress, tmp = 'hosp_tmp.mp4' } = {}) {
  const p = planRecipe(info, R, baseProf);
  const passes = R.loop.on ? 2 : 1, prog = (i, f) => f && (x => f((i + Math.min(1, x)) / passes));
  const args = encodeArgs(src, R.loop.on ? tmp : dst, R.loop.on ? { ...p.prof, crf: 14, preset: 'veryfast', minSeconds: 0 } : p.prof, p.cur, { pre: p.pre, extra: p.extra, seek: p.seek, limit: p.limit, repeat: 1 });
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
