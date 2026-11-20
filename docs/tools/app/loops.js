// Loop analysis and loop making (port of vjtools/loops.py). Works through the engine interface.
import { chooseFps, encodeArgs, repeatsNeeded, parseProbe } from './core.js';

const W = 64, H = 36, S = W * H;

export async function probe(engine, path, name = '') {
  const { log } = await engine.exec(['-hide_banner', '-i', path]);
  return parseProbe(log.join('\n'), name || path);
}

// grey 64x36 pictures at `fps`, as one Uint8Array (n * S)
export async function grayFrames(engine, path, fps, maxFrames = 20000, onProgress) {
  const out = `g_${Math.random().toString(36).slice(2)}.raw`;
  // fps 0: every frame of the file as it is, one grey picture each (no frames added or dropped to fit a rate)
  const r = await engine.exec(['-y', '-hide_banner', '-i', path, '-an', '-vf', `${fps ? `fps=${fps},` : ''}scale=${W}:${H}:flags=area,format=gray`, ...(fps ? [] : ['-fps_mode', 'passthrough']), '-frames:v', String(maxFrames), '-f', 'rawvideo', out], onProgress ? { onProgress } : undefined);
  if (r.code !== 0) throw new Error('Could not read this video');
  const data = await engine.read(out);
  await engine.remove(out);
  return { data, n: Math.floor(data.length / S) };
}

const meanDiff = (a, ia, b, ib) => { let s = 0; const oa = ia * S, ob = ib * S; for (let i = 0; i < S; i++) s += Math.abs(a[oa + i] - b[ob + i]); return s / S / 255; };
function percentile(sorted, q) { const p = (sorted.length - 1) * q / 100, lo = Math.floor(p), hi = Math.ceil(p); return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo); }

export function analyzeFrames(data, n, fps) { return analyzeCore(data, n, fps); }
// the loop report, with the plan Auto would make (for the time estimate); planLoop calls analyzeCore itself
export function analyzeWithPlan(data, n, fps) { const r = analyzeCore(data, n, fps); try { const p = planLoop(data, n, fps, { fadeAuto: true }); r.plan = { method: p.method, len: p.len, n }; } catch (e) { /* no plan */ } return r; }
function analyzeCore(data, n, fps) {
  if (n < 4) return { frames: n, fps, wrap: 0, stepTyp: 0, ratio: 0, isLoop: false, verdict: 'jump', bestCut: -1, bestRatio: 9e9, bestKeeps: 0 };
  const steps = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) steps[i] = meanDiff(data, i, data, i + 1);
  const ref = Math.max(percentile(Float64Array.from(steps).sort(), 90), 0.004);
  const wrap = meanDiff(data, n - 1, data, 0), ratio = wrap / ref;
  const isLoop = ratio <= 1.25 || wrap < 0.01, verdict = isLoop ? 'seamless' : ratio <= 3 ? 'almost' : 'jump';
  const lo = Math.floor(n / 2), len = n - 1 - lo;   // candidates k = lo .. n-2, compare frame k+1 with frame 0
  let best = -1, bestCost = Infinity;
  for (let j = 0; j < len; j++) { const c = meanDiff(data, lo + j + 1, data, 0) + 1e-9 * (len - j); if (c < bestCost) { bestCost = c; best = j; } }
  if (best < 0) return { frames: n, fps, wrap, stepTyp: ref, ratio, isLoop, verdict, bestCut: -1, bestRatio: 9e9, bestKeeps: 0 };
  const k = lo + best, raw = meanDiff(data, k + 1, data, 0);
  return { frames: n, fps, wrap, stepTyp: ref, ratio, isLoop, verdict, bestCut: k, bestRatio: raw / ref, bestKeeps: (k + 1) / n };
}

// the state before, in plain words, for the notes on a finished clip
export function beforeText(r) { return r.isLoop || r.verdict === 'seamless' ? 'already seamless' : r.verdict === 'almost' ? 'a small jump at the loop point' : 'a clear jump at the loop point'; }
export function reportText(r) {
  let s = `${r.verdict} (loop jump ${r.ratio.toFixed(1)}x a normal frame step)`;
  if (!r.isLoop && r.bestCut >= 0 && r.bestRatio <= 1.25) s += `; a better loop point exists after frame ${r.bestCut} (keeps ${Math.round(r.bestKeeps * 100)} %)`;
  return s;
}

export async function analyze(engine, path, info) {
  const fps = chooseFps(info, { fps: 0, maxFps: 60 });
  const { data, n } = await grayFrames(engine, path, fps);
  return analyzeWithPlan(data, n, fps);
}

// ---------------------------------------------------------------------------------------------- choosing how to make it loop
// planLoop looks at the grey pictures of the finished clip and decides how to close the loop, preferring ways that keep the movement
// going in one direction for as long as possible:
//   asis       the clip already loops
//   trim       cut at the LATEST frame that joins the start cleanly (the longest clean loop, not just the best point)
//   crossfade  cut and blend the end into the start; with fadeAuto the cut AND the length of the blend are chosen together, so the
//              two blended moments look as much alike as possible (little ghosting), still keeping the loop long
//   pingpong   forward and back, the last resort: it cannot move further than the clip is long. Turns are gentle (about 1.2 s of
//              slowing down and speeding up) unless turn = 'quick' (0.6 s, the old way)
// Returns { method, cut (frames kept), xf (frames blended), E (frames of each eased turn), len (frames out), ghost, ratio, why }.
const S16 = 16 * 9;
function small(data, n) {   // 64 x 36 -> 16 x 9, averaged: enough to compare, sixteen times less work
  const o = new Float32Array(n * S16);
  for (let f = 0; f < n; f++) for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) o[f * S16 + (y >> 2) * 16 + (x >> 2)] += data[f * S + y * 64 + x] / 16;
  return o;
}
const d16 = (a, i, j) => { let s = 0; const oi = i * S16, oj = j * S16; for (let k = 0; k < S16; k++) s += Math.abs(a[oi + k] - a[oj + k]); return s / S16 / 255; };
// the same, but with each picture's overall brightness taken out: blending two moments that differ only in brightness shows no ghost
const mean16 = (a, i) => { let s = 0; const o = i * S16; for (let k = 0; k < S16; k++) s += a[o + k]; return s / S16; };
const g16 = (a, m, i, j) => { let s = 0; const oi = i * S16, oj = j * S16, dm = m[i] - m[j]; for (let k = 0; k < S16; k++) s += Math.abs(a[oi + k] - a[oj + k] - dm); return s / S16 / 255; };
export const TURN = { gentle: 1.2, quick: 0.6 };
export function turnFrames(n, fps, turn = 'gentle') { const A = n - 1; return Math.min(Math.round((TURN[turn] || TURN.gentle) * fps), Math.floor(A / 3)); }
export function planLoop(data, n, fps, { mode = 'auto', fade = 1.5, fadeAuto = false, fallback = 'pingpong', turn = 'gentle' } = {}) {
  const rep = analyzeCore(data, n, fps), E = turnFrames(n, fps, turn);
  const ping = why => ({ method: 'pingpong', cut: n, xf: 0, E, len: E >= 3 ? Math.round(2 * ((n - 1) - 2 * E + Math.PI * E)) : 2 * n - 2, rep, why });
  if (n < 6) return { method: 'asis', cut: n, xf: 0, E, len: n, rep, why: 'too short to change' };
  const g = small(data, n), ref = Math.max(rep.stepTyp, 0.004), mu = Float32Array.from({ length: n }, (_, i) => mean16(g, i));
  // trim: the latest cut (at least 60 % kept) whose join is clean, or nearly as clean as the best one
  const lo = Math.max(2, Math.floor(n * 0.6)), joins = [];
  for (let c = lo; c <= n - 1; c++) joins.push([c, d16(g, c, 0) / ref]);   // keep frames 0..c-1, frame c would be the next: compare it with frame 0
  const bestJ = joins.reduce((a, b) => (b[1] < a[1] ? b : a), [n, 9e9]);
  const okJ = joins.filter(j => j[1] <= Math.max(1.25, bestJ[1] * 1.1)), trim = okJ.length ? okJ.reduce((a, b) => (b[0] > a[0] ? b : a)) : bestJ;
  // crossfade: the tail that starts at k is blended over the head (frames 0..xf-1); the result is k frames long
  const cross = fixedXf => {
    const maxXf = Math.max(2, Math.min(Math.round(4 * fps), Math.floor(n / 3))), minXf = Math.max(2, Math.min(Math.round(0.8 * fps), Math.floor(n / 4)));   // shorter than ~0.8 s reads as a jump with a ghost
    const xfs = fixedXf ? [Math.max(2, Math.min(fixedXf, Math.floor(n / 3)))] : Array.from({ length: Math.max(1, Math.floor((maxXf - minXf) / Math.max(1, Math.round(fps / 10))) + 1) }, (_, i) => Math.min(maxXf, minXf + i * Math.max(1, Math.round(fps / 10))));
    let best = null;
    for (const xf of xfs) {
      const w = Array.from({ length: xf }, (_, i) => { const x = (i + 1) / (xf + 1), s = x * x * x * (x * (x * 6 - 15) + 10); return 4 * s * (1 - s); }), ws = w.reduce((a, b) => a + b, 0) || 1;
      for (let k = Math.max(xf, Math.floor(n * 0.6)); k + xf <= n; k++) {
        let s = 0; for (let i = 0; i < xf; i += 1) s += w[i] * g16(g, mu, k + i, i);
        const ghost = s / ws / ref, len = k;
        // little ghosting first, then the longer loop. Where the two moments differ more, a short blend shows as a jump with a ghost,
        // while a long one reads as a slow morph: so the more they differ, the more a long blend is wanted
        const sec = xf / Math.max(1, fps), score = ghost + 3 * (1 - len / n) - 0.15 * Math.min(sec, 2.5) + Math.max(0, ghost - 1.2) * Math.max(0, 1.2 - sec);
        if (!best || score < best.score) best = { method: 'crossfade', cut: k + xf, xf, E, len, ghost, score, rep };
      }
    }
    return best;
  };
  const fadeF = Math.max(2, Math.round((+fade || 1.5) * fps));
  if (mode === 'asis' || mode === 'none') return { method: 'asis', cut: n, xf: 0, E, len: n, rep, why: 'as asked' };
  if (mode === 'pingpong') return ping('as asked');
  if (mode === 'trim') return { method: 'trim', cut: trim[0], xf: 0, E, len: trim[0], ratio: trim[1], rep, why: 'as asked' };
  if (mode === 'crossfade') { const c = cross(fadeAuto ? 0 : fadeF); return c ? { ...c, why: 'as asked' } : ping('too short to crossfade'); }
  // auto: the cleanest way that keeps the movement going one way, and the longest of the good ones
  if (rep.isLoop) return { method: 'asis', cut: n, xf: 0, E, len: n, rep, why: 'already loops' };
  const c = cross(0), cands = [];
  if (trim[1] <= 1.25) cands.push({ method: 'trim', cut: trim[0], xf: 0, E, len: trim[0], ratio: trim[1], rep, bad: 0 });
  if (c && c.ghost <= 3.5) cands.push({ ...c, bad: c.ghost / 3.5 });
  if (!cands.length) return fallback === 'crossfade' && c ? { ...c, why: 'no clean join; blended' } : ping('no clean join and no good blend');
  // a clean cut wins unless a blend keeps clearly more of the clip
  cands.sort((a, b) => (b.len * (1 - 0.15 * b.bad)) - (a.len * (1 - 0.15 * a.bad)));
  return { ...cands[0], why: cands[0].method === 'trim' ? 'clean join' : 'blend with little ghosting' };
}
// a short note on what was done
export function planNote(p, fps) {
  const s = f => Math.round(f / fps * 10) / 10;
  return { asis: p.rep && p.rep.isLoop ? 'already loops' : 'kept as is', trim: `trimmed to the longest clean loop (${s(p.cut)} s)`,
    crossfade: `end crossfaded into the start (${s(p.xf)} s blend, ${s(p.len)} s loop)`, pingpong: `played forward then backward (${s(p.E)} s turns)` }[p.method];
}

const normProfile = prof => ({ ...prof, crf: 12, preset: 'ultrafast', gop: 15, minSeconds: 0, keepAudio: false });
const encOut = (fps) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', '15', '-r', String(fps), '-fps_mode', 'cfr', '-an'];
let uid = 0;
// Maps a step's own 0..1 progress onto a part [a, b] of the whole, so a long job reports steadily instead of jumping or standing still.
const part = (report, a, b) => report ? x => report(a + (b - a) * Math.max(0, Math.min(1, +x || 0))) : undefined;
const tmpName = (tag, ext = 'mp4') => `t${Date.now().toString(36)}${++uid}_${tag}.${ext}`;

async function makePingpong(engine, inter, out, fps, ctl, budget = 200e6, report, turn = 'gentle') {
  const { n: N } = await grayFrames(engine, inter, fps, 20000, part(report, 0, 0.08));
  if (N < 3) throw new Error('Clip is too short to make a loop of');
  const info = await probe(engine, inter);
  const per = Math.max(1, Math.floor(info.width * info.height * 3 / 2)), C = Math.max(24, Math.floor(budget / per));
  const parts = [], lo = 1, hi = N - 1, chunks = [];
  for (let a = lo; a < hi; a += C) chunks.push([a, Math.min(a + C, hi)]);
  for (let ci = chunks.length - 1; ci >= 0; ci--) {
    ctl.check();
    const [a, b] = chunks[ci], p = tmpName(`rev${ci}`);
    const ss = a === 0 ? [] : ['-ss', ((a - 0.5) / fps).toFixed(6)];
    const cr = part(report, 0.08 + 0.52 * (chunks.length - 1 - ci) / chunks.length, 0.08 + 0.52 * (chunks.length - ci) / chunks.length);
    const r = await engine.exec(['-y', ...ss, '-i', inter, '-vf', `trim=end_frame=${b - a},reverse,setpts=N/FRAME_RATE/TB`, '-frames:v', String(b - a), ...encOut(fps), p], cr ? { onProgress: cr } : undefined);
    if (r.code !== 0) throw new Error('Reversing failed (not enough memory? try a smaller size)');
    parts.push(p);
  }
  const list = tmpName('list', 'txt');
  await engine.write(list, new TextEncoder().encode([inter, ...parts, inter].map(p => `file '${p}'\n`).join('')));
  // Organic turnaround: speed is constant everywhere, but eases to a stop and back over ~0.6 s at each
  // reversal (cosine speed ramp), instead of flipping direction in one frame. Retimed with setpts and
  // blended with `framerate`, so there are no repeated frames in the slow part.
  const A = N - 1, E = turnFrames(N, fps, turn);
  let vf = [];
  let total = 2 * N - 2;
  if (E < 3) await engine.write(list, new TextEncoder().encode([inter, ...parts].map(p => `file '${p}'\n`).join('')));
  if (E >= 3) {
    const seg = A - 2 * E + Math.PI * E;
    const j = 'if(gte(N,' + A + '),N-' + A + ',N)';
    const t = `if(lt(${j},${E}),${E}*acos(1-${j}/${E}),if(gt(${j},${A - E}),${seg.toFixed(6)}-${E}*acos(1-(${A}-${j})/${E}),${(E * Math.PI / 2 - E).toFixed(6)}+${j}))`;
    vf = ['-vf', `trim=end_frame=${2 * A + 1},setpts='(if(gte(N,${A}),${seg.toFixed(6)},0)+${t})/FRAME_RATE/TB',framerate=fps=${fps}:interp_start=0:interp_end=255:scene=100`];
    total = Math.round(2 * seg);
  }
  const r = await engine.exec(['-y', '-f', 'concat', '-safe', '0', '-i', list, ...vf, ...(E >= 3 ? ['-frames:v', String(total)] : []), ...encOut(fps), out], report ? { onProgress: part(report, 0.6, 1) } : undefined);
  await engine.remove(list); for (const p of parts) await engine.remove(p);
  if (r.code !== 0) throw new Error('Joining the loop failed');
  return total;
}

async function makeCrossfade(engine, inter, out, fps, xfFrames, report) {
  const { n: N } = await grayFrames(engine, inter, fps, 20000, part(report, 0, 0.15));
  const xf = Math.min(xfFrames, Math.floor(N / 3));
  if (xf < 2) throw new Error('Clip is too short for a crossfaded loop');
  const w = `st(0,(N+1)/${xf + 1});st(1,ld(0)*ld(0)*ld(0)*(ld(0)*(ld(0)*6-15)+10))`;
  const fg = `[0:v]split=2[h0][r0];[h0]trim=end_frame=${xf},setpts=PTS-STARTPTS[head];` +
    `[r0]trim=start_frame=${xf}:end_frame=${N - xf},setpts=PTS-STARTPTS[rest];` +
    `[1:v]trim=end_frame=${xf},setpts=PTS-STARTPTS[tail];` +
    `[tail][head]blend=all_expr='${w};A*(1-ld(1))+B*ld(1)'[bl];[bl][rest]concat=n=2:v=1:a=0[v]`;
  const ss = Math.max(0, (N - xf - 0.5) / fps).toFixed(6);
  const r = await engine.exec(['-y', '-i', inter, '-ss', ss, '-i', inter, '-filter_complex', fg, '-map', '[v]', ...encOut(fps), out], report ? { onProgress: part(report, 0.15, 1) } : undefined);
  if (r.code !== 0) throw new Error('Crossfade failed');
  return N - xf;
}

// Make dstName a VJ-friendly clip that loops without a visible jump. Returns { note, method }.
// What makeLoop will most likely do with a clip whose loop report is rep, and how long the result gets (len = seconds going in).
// Used for the time estimate, before the work is done.
export function loopForecast(rep, { mode = 'auto', fade = 1.5, fadeAuto = false, fallback = 'pingpong', turn = 'gentle' } = {}, len = 0) {
  // the plan worked out on the original clip (rep.plan) shows what Auto will most likely do and how much of the clip it keeps
  const pl = rep && rep.plan;
  let m = mode, keep = 1;
  if (m === 'auto') { if (pl) { m = pl.method; keep = pl.len / Math.max(1, pl.n); } else m = rep && rep.isLoop ? 'asis' : rep && rep.bestCut >= 0 && rep.bestRatio <= 1.25 && rep.bestKeeps >= 0.6 ? 'trim' : fallback; }
  if (m === 'none') m = 'asis';
  if (m === 'trim' && !(rep && rep.bestCut >= 0) && !pl) m = fallback;
  const T = TURN[turn] || TURN.gentle;
  // back and forth: twice as long, plus the eased turns (a quarter circle longer than a straight run)
  const out = m === 'pingpong' ? 2 * len + 2 * (Math.PI - 2) * Math.min(T, len / 3) : m === 'crossfade' ? (mode === 'auto' && pl ? len * keep : Math.max(len * 0.5, len - (fadeAuto ? 1.5 : (+fade || 0)))) : m === 'trim' ? len * (mode === 'auto' && pl ? keep : Math.max(0.3, (rep && rep.bestKeeps) || 1)) : len;
  return { method: m, len: out };
}
export async function makeLoop(engine, src, dst, prof, info, { mode = 'auto', fade = 1.5, fadeAuto = false, fallback = 'pingpong', turn = 'gentle', ctl = { check() {} }, onProgress } = {}) {
  const fps = chooseFps(info, prof), R = (a, b) => part(onProgress, a, b);
  const g = await grayFrames(engine, src, fps, 20000, R(0, 0.06));
  const pl = planLoop(g.data, g.n, fps, { mode, fade, fadeAuto, fallback, turn }), rep = pl.rep, method = pl.method;
  const finish = async (from, finfo, frames) => {
    const dur = frames / fps;
    const r = await engine.exec(encodeArgs(from, dst, prof, finfo, { repeat: repeatsNeeded(dur, prof.minSeconds) }), { onProgress: R(0.7, 1) });
    if (r.code !== 0) throw new Error('Encoding failed');
  };
  if (method === 'asis') {
    const r = await engine.exec(encodeArgs(src, dst, prof, info, { repeat: repeatsNeeded(info.duration, prof.minSeconds) }), { onProgress: R(0.06, 1) });
    if (r.code !== 0) throw new Error('Encoding failed');
    return { note: `${planNote(pl, fps)} (before: ${beforeText(rep)})`, method: 'asis' };
  }
  const tmps = [];
  try {
    ctl.check();
    const inter = tmpName('norm'); tmps.push(inter);
    const ir = await engine.exec(encodeArgs(src, inter, normProfile(prof), info, { trimFrames: method === 'trim' || method === 'crossfade' ? pl.cut : 0 }), { onProgress: R(0.06, 0.3) });
    if (ir.code !== 0) throw new Error('Encoding failed');
    let frames, from;
    if (method === 'trim') { frames = pl.cut; from = inter; }
    else {
      from = tmpName('loop'); tmps.push(from);
      frames = method === 'pingpong' ? await makePingpong(engine, inter, from, fps, ctl, undefined, R(0.3, 0.7), turn) : await makeCrossfade(engine, inter, from, fps, pl.xf, R(0.3, 0.7));
    }
    ctl.check();
    await finish(from, await probe(engine, from), frames);
  } finally { for (const t of tmps) await engine.remove(t); }
  return { note: `${planNote(pl, fps)}; before: ${beforeText(rep)}`, method };
}
