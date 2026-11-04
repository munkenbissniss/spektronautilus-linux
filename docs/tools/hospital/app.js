import { VIDEO_EXT, GIF_EXT, extOf, stemOf, defaultProfile, fmtSize } from '../app/core.js';
import { FILTERS } from '../app/filters.js';
import { getEngine } from '../app/engine.js';
import * as L from '../app/loops.js';
import * as ST from '../app/steps.js';
import { makeZip } from '../app/zip.js';
import { injectCSS, clamp01, fmtDur } from '../../shared/progress.js';
injectCSS();

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const engine = getEngine(), T = s => (window.SPK_T ? window.SPK_T(s) : s);
const R = ST.defaultRecipe();
const OK_EXT = new Set([...VIDEO_EXT, ...GIF_EXT]);
let patient = null, busy = false, ctl = null, RESULTS = [], nextId = 1;

// ---------------------------------------------------------------------------------------------- the treatment steps
const num = (k, l, h) => ({ k, t: 'number', l, h });
const sel = (k, l, o, n) => ({ k, t: 'select', l, o, n });
const KB_MODES_UI = ST.KB_MODES;
const seg = (k, l, o, n, h) => ({ k, t: 'seg', l, o, n, h });
const fill = (s, a) => T(s).replace(/\{(\w)\}/g, (m, k) => a[k]);
const STEPS = [
  { s: 'cut', ic: '✂️', title: 'Cut', hint: 'Remove the start or the end of the clip.', f: [num('start', 'Start at (seconds)', 'Cuts this much off the beginning.'), num('len', 'Length (seconds)', '0 = until the end of the clip.')] },
  { s: 'rotate', ic: '🔄', title: 'Rotate', hint: 'Turn the picture, or mirror it.', f: [
    seg('turn', 'Turn', [['0', 'No turn'], ['90', '↻ 90° right'], ['270', '↺ 90° left'], ['180', '180°']]),
    seg('flip', 'Mirror', [['none', 'No mirror'], ['h', '↔ Left to right'], ['v', '↕ Upside down']])] },
  { s: 'crop', ic: '🔲', title: 'Crop to a shape', hint: 'Cut the picture to the shape you need.', f: [
    seg('shape', 'Shape', [['169', '16:9'], ['916', '9:16'], ['11', '1:1'], ['43', '4:3'], ['219', '21:9']]),
    seg('pos', 'Keep which part', [['c', 'The middle'], ['a', 'The start'], ['z', 'The end']])] },
  { s: 'smooth', ic: '🧈', title: 'Smooth out', hint: 'Fix jerky movement. It finds the places where the picture lurches or crawls and evens out the speed. The clip can come out a little shorter or longer.', f: [
    { k: 'strength', t: 'range', l: 'How much to even out', min: 0, max: 100, step: 5, h: 'Higher is smoother, but it changes the natural rhythm of the clip more.' },
    { k: 'dropOdd', t: 'bool', l: 'Remove stray frames that jump out of place', adv: 1 }] },
  { s: 'slow', ic: '🐢', title: 'Slow motion', hint: 'Make the clip slower, or smoother.', f: [
    seg('factor', 'How much slower', [['2', '2×'], ['4', '4×'], ['8', '8×']], 1),
    seg('mode', 'Result', [['slow', 'Slow motion'], ['smooth', 'Same speed, smoother']], 0, 'Slow motion makes the clip longer. Smoother adds frames per second.'),
    seg('engine', 'Method', [['blend', 'Soft blend'], ['motion', 'Smooth motion'], ['ai', 'AI (best)']], 0, 'Soft blend is fast. Smooth motion is slower, but cleaner on fast movement. AI gives the best result, but needs the Linux version with Video2X and a graphics card. It can take a long time.'),
    sel('model', 'AI model', [['rife-v4.6', 'General video'], ['rife-v4.26', 'Newest model']]),
    { k: 'gpu', t: 'number', l: 'Graphics card number for AI (0 = automatic)', h: 'Automatic picks a real graphics card and avoids the slow software driver. Change it only if the wrong card is used.', adv: 1 }] },
  { s: 'life', ic: '🌿', title: 'Bring it to life', hint: 'Make still or short loops more alive: slow in and out, a gentle breathing, a floating camera. The clip is repeated to the length you choose, and the movement fits exactly, so it still loops without a jump.', f: [
    seg('style', 'Style', [['calm', 'Calm breathing'], ['float', 'Floating'], ['dream', 'Dreamy'], ['pulse', 'Pulse']], 0, 'Pick a style, then fine-tune under Advanced if you like.'),
    { k: 'minSeconds', t: 'range', l: 'Make it at least (seconds)', min: 0, max: 60, step: 1, h: 'The loop is repeated until it is this long. 16 s and longer suits the Magic Video Mixer.' },
    { k: 'ease', t: 'range', l: 'Slow in and out', min: 0, max: 100, step: 5, adv: 1, h: 'The movement lingers at the loop point and glides through the middle.' },
    { k: 'breathe', t: 'range', l: 'Breathing zoom', min: 0, max: 100, step: 5, adv: 1 },
    { k: 'drift', t: 'range', l: 'Floating', min: 0, max: 100, step: 5, adv: 1, h: 'The picture drifts slowly sideways and up and down. It is enlarged a little so no edges show.' },
    { k: 'sway', t: 'range', l: 'Gentle tilt', min: 0, max: 100, step: 5, adv: 1 },
    { k: 'glow', t: 'range', l: 'Light and colour breathing', min: 0, max: 100, step: 5, adv: 1 },
    { k: 'trails', t: 'bool', l: 'Soft trails', adv: 1 }] },
  { s: 'kb', ic: '🎥', title: 'Ken Burns', hint: 'A slow, gliding zoom or pan over the whole clip, like a camera that moves very gently. The clip is repeated to the length you choose, and the camera glides back to where it began, so it still loops without a jump.', f: [
    seg('mode', 'Movement', KB_MODES_UI, 0),
    { k: 'amount', t: 'range', l: 'How far', min: 5, max: 100, step: 5, h: 'A small number is a very subtle move. 100 moves the camera about a third of the way in.' },
    { k: 'minSeconds', t: 'range', l: 'Make it at least (seconds)', min: 8, max: 120, step: 2, h: 'The whole movement takes this long. Longer is slower and smoother. 24 s and longer glides nicely.' },
    { k: 'ret', t: 'bool', l: 'Glide back to the start (keeps it looping)', adv: 1 }] },
  { s: 'up', ic: '🔍', title: 'Upscale', hint: 'Make the picture larger and sharper.', f: [
    seg('engine', 'Method', [['sharp', 'Sharp (fast)'], ['ai', 'AI (best)']], 0, 'Sharp works everywhere. AI gives the best result, but needs the Linux version with Video2X and a graphics card. It can take a long time.'),
    seg('scale', 'Make it this much bigger', [['2', '2×'], ['3', '3×'], ['4', '4×']], 1),
    { k: 'sharp', t: 'range', l: 'Sharpness (Sharp method)', min: 0, max: 100, step: 5 },
    sel('model', 'Kind of picture (AI)', [['realesr-animevideov3', 'Cartoons and animation'], ['realesrgan-plus', 'Photos and real film (always 4×)'], ['anime4k', 'Fast, for animation (Anime4K)']])] },
  { s: 'size', ic: '📐', title: 'Resize', hint: 'Fit the clip to a size box. Portrait clips are turned automatically.', f: [
    sel('box', 'Size', ['1280x720', '1920x1080', '2560x1440', '3840x2160']),
    seg('fit', 'Fit', [['keep', 'Only shrink'], ['fit', 'Letterbox'], ['fill', 'Crop to fill']]),
    { k: 'upscale', t: 'bool', l: 'Enlarge small videos up to the box' }] },
  { s: 'look', ic: '🎨', title: 'Look', hint: 'Give the clip a style. Pick several to get one file for each.', f: [
    { k: 'ids', t: 'looks' }, { k: 'amount', t: 'range', l: 'Strength', min: 0, max: 100, step: 1 },
    { k: 'keepOriginal', t: 'bool', l: 'Also save the clip without a look' }] },
  { s: 'loop', ic: '♾️', title: 'Make it loop', hint: 'Hide the jump where the clip starts over.', f: [
    seg('mode', 'Method', [['auto', 'Auto'], ['pingpong', 'Back and forth'], ['crossfade', 'Crossfade'], ['trim', 'Trim']], 0, 'Auto keeps good loops and fixes the rest. Back and forth plays forward, then backward. Crossfade blends the end into the start. Trim cuts at the best loop point.'),
    { k: 'fade', t: 'range', l: 'Crossfade length (s)', min: 0.3, max: 8, step: 0.1 }] },
];
const OUT = [sel('fps', 'Frames per second', [['0', 'Keep (snapped to 24/25/30/50/60)'], ['24', '24'], ['25', '25'], ['30', '30'], ['50', '50'], ['60', '60']], 1),
  { k: 'crf', t: 'range', l: 'Quality (lower = better, larger)', min: 12, max: 28, step: 1 },
  { k: 'minSeconds', t: 'range', l: 'Repeat until at least (s)', min: 0, max: 120, step: 1, h: 'Whole loops are repeated. 0 = off. The Magic Video Mixer likes 16 s and longer.' }];

function field(s, f) {
  const id = `h_${s}_${f.k}`, v = R[s][f.k];
  const hint = f.h ? `<div class="h">${esc(f.h)}</div>` : '';
  if (f.t === 'looks') {
    return `<div class="f wide"><label>Looks</label><div class="chips" id="looks">${FILTERS.map(x => `<label title="${esc(x.desc || '')}"><input type="checkbox" data-look="${x.id}"${R.look.ids.includes(x.id) ? ' checked' : ''}><span>${esc(x.name)}</span></label>`).join('')}</div><div class="h" id="lookcount" role="status"></div></div>`;
  }
  let c;
  if (f.t === 'range') c = `<div class="ctl"><input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}" data-s="${s}" data-k="${f.k}"><output>${v}</output></div>`;
  else if (f.t === 'seg') c = `<div class="seg" role="radiogroup" aria-label="${esc(f.l)}">${f.o.map(([ov, ol]) => `<label><input type="radio" name="${id}" value="${esc(ov)}" data-s="${s}" data-k="${f.k}"${f.n ? ' data-num="1"' : ''}${String(ov) === String(v) ? ' checked' : ''}><span>${esc(ol)}</span></label>`).join('')}</div>`;
  else if (f.t === 'select') c = `<select id="${id}" data-s="${s}" data-k="${f.k}"${f.n ? ' data-num="1"' : ''}>${f.o.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}"${String(ov) === String(v) ? ' selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
  else if (f.t === 'bool') c = `<label style="display:flex;gap:6px;align-items:center"><input id="${id}" type="checkbox" data-s="${s}" data-k="${f.k}"${v ? ' checked' : ''}> <span style="font-size:.9rem">${esc(f.l)}</span></label>`;
  else c = `<input id="${id}" type="number" min="0" step="0.1" value="${v}" data-s="${s}" data-k="${f.k}">`;
  const lab = f.t === 'bool' ? '' : f.t === 'seg' ? `<label>${esc(f.l)}</label>` : `<label for="${id}">${esc(f.l)}</label>`;
  return `<div class="f${f.t === 'seg' ? ' wide' : ''}">${lab}${c}${hint}</div>`;
}
function buildSteps() {
  $('#tiles').innerHTML = STEPS.map(st => `<button type="button" class="tile" data-tile="${st.s}" aria-pressed="${!!R[st.s].on}"><span class="ic" aria-hidden="true">${st.ic}</span><span>${esc(st.title)}</span></button>`).join('');
  $('#steps').innerHTML = STEPS.map(st => `<section class="step${R[st.s].on ? '' : ' hide'}" data-step="${st.s}"><h3><span class="ic" aria-hidden="true">${st.ic}</span><span>${esc(st.title)}</span><span class="sp"></span><button type="button" class="x" data-off="${st.s}" aria-label="Remove this treatment" title="Remove this treatment">×</button></h3><div class="hint">${esc(st.hint)}</div><div class="fields">${st.f.filter(f => !f.adv).map(f => field(st.s, f)).join('')}${st.f.some(f => f.adv) ? `<details class="adv"><summary>Advanced</summary><div class="fields" style="margin:8px 0 0">${st.f.filter(f => f.adv).map(f => field(st.s, f)).join('')}</div></details>` : ''}</div></section>`).join('');
  $('#outf').innerHTML = OUT.map(f => field('out', f)).join('');
  lookCount();
}
function setOn(s, on) {
  R[s].on = on;
  const tile = document.querySelector(`[data-tile="${s}"]`); if (tile) tile.setAttribute('aria-pressed', String(on));
  const st = document.querySelector(`[data-step="${s}"]`); if (st) st.classList.toggle('hide', !on);
  info();
}
function lookCount() {
  const el = $('#lookcount'); if (!el) return;
  const n = ST.variants(R).length;
  el.textContent = n === 1 ? T('One file will be made.') : fill('{a} files will be made, one for each look.', { a: n });
}
function syncUI() {   // push the recipe into the inputs after a suggestion was added
  document.querySelectorAll('[data-s]').forEach(e => {
    const v = R[e.dataset.s][e.dataset.k];
    if (e.type === 'checkbox') e.checked = !!v; else if (e.type === 'radio') e.checked = String(v) === e.value;
    else { e.value = String(v); const o = e.nextElementSibling; if (e.type === 'range' && o) o.textContent = e.value; }
  });
  document.querySelectorAll('[data-look]').forEach(e => { e.checked = R.look.ids.includes(e.dataset.look); });
  STEPS.forEach(st => setOn(st.s, !!R[st.s].on));
  lookCount(); info();
}
function aiBtn() { const b = $('#aiprev'); if (b) b.classList.toggle('hide', !(ST.v2xReady(engine) && ((R.slow.on && R.slow.engine === 'ai') || (R.up.on && R.up.engine === 'ai')))); }
function info() {
  aiBtn();
  const on = STEPS.filter(s => R[s.s].on).map(s => T(s.title));
  $('#info').textContent = on.length ? on.join(' → ') : T('No treatment ticked yet. The clip is only made VJ-friendly.');
}
$('#tiles').addEventListener('click', e => { const b = e.target.closest('[data-tile]'); if (b) setOn(b.dataset.tile, b.getAttribute('aria-pressed') !== 'true'); });
$('#steps').addEventListener('click', e => { const b = e.target.closest('[data-off]'); if (b) setOn(b.dataset.off, false); });
$('#steps').addEventListener('change', e => {
  const l = e.target.dataset.look; if (!l) return;
  const ids = [...document.querySelectorAll('[data-look]')].filter(x => x.checked).map(x => x.dataset.look);
  if (!ids.length) { e.target.checked = true; return; }   // at least one look must stay
  R.look.ids = ids; if (ids.length) R.look.id = ids[0]; lookCount();
});
function onField(e) {
  const t = e.target, s = t.dataset.s, k = t.dataset.k; if (!s) return;
  if (t.type === 'radio' && !t.checked) return;
  const v = t.type === 'checkbox' ? t.checked : (t.type === 'range' || t.type === 'number' || t.dataset.num) ? Number(t.value) : t.value;
  R[s][k] = v; if (t.type === 'range' && t.nextElementSibling) t.nextElementSibling.textContent = t.value;
  if (s === 'life') {   // a style fills the sliders; touching a slider makes it a custom mix
    if (k === 'style' && ST.LIFE_STYLES[v]) { Object.assign(R.life, ST.LIFE_STYLES[v]); syncUI(); }
    else if (k !== 'minSeconds' && k !== 'style') { R.life.style = 'custom'; document.querySelectorAll('[data-s=life][data-k=style]').forEach(r => { r.checked = false; }); }
  }
  if (s === 'look') lookCount();
  aiBtn();
}
document.addEventListener('input', onField); document.addEventListener('change', onField);

// ---------------------------------------------------------------------------------------------- engine and files
const status = t => { $('#engine').textContent = t || ''; };
function aiAvail() {   // the AI choices only work with the local Linux version and Video2X
  const ok = ST.v2xReady(engine), why = T('AI needs the Linux version with Video2X installed.');
  document.querySelectorAll('[data-s=slow][data-k=engine][value=ai], [data-s=up][data-k=engine][value=ai]').forEach(r => { r.disabled = !ok; r.parentElement.title = ok ? '' : why; });
  ['slow', 'up'].forEach(k => { if (!ok && R[k].engine === 'ai') { R[k].engine = k === 'up' ? 'sharp' : 'blend'; syncUI(); } });
}
async function ensureEngine() { if (engine.pick) { try { await engine.pick(); } catch (e) { /* the web engine loads below */ } } await engine.load(status); status(''); aiAvail(); }
const openInput = async file => engine.mount(new File([file], 'src' + (extOf(file.name) || '.mp4'), { type: file.type }));
const okFile = f => OK_EXT.has(extOf(f.name));

async function choose(file, converted) {
  if (!file) return;
  $('#gifbar').classList.add('hide'); if (!converted) $('#gifdone').classList.add('hide');
  if (!okFile(file)) { $('#msg').textContent = 'That is not a video type I know.'; return; }
  if (patient) URL.revokeObjectURL(patient.url);
  patient = { file, url: URL.createObjectURL(file), info: null, loop: null };
  $('#vbefore').src = patient.url; $('#patient').classList.remove('hide'); $('#fafter').classList.add('hide'); $('#vafter').removeAttribute('src');
  ['c3', 'c4'].forEach(i => $('#' + i).classList.remove('hide')); RESULTS.forEach(r => URL.revokeObjectURL(r.url)); $('#res').innerHTML = ''; RESULTS = []; $('#more').classList.add('hide'); $('#msg').textContent = '';
  $('#facts').innerHTML = `<span class="muted">Examining…</span>`; $('#findings').innerHTML = ''; $('#healall').classList.add('hide');
  let path;
  try {
    await ensureEngine(); path = await openInput(file);
    const inf = await L.probe(engine, path, file.name); if (!inf.width) throw new Error('No picture found in this file');
    patient.info = inf;
    if (inf.duration > 0 && inf.duration <= 60) { try { patient.loop = await L.analyze(engine, path, inf); } catch (e) { patient.loop = null; } }
    examine();
  } catch (e) { $('#facts').innerHTML = ''; $('#msg').textContent = e.message; }
  finally { if (path) await engine.unmount(path); }
}
let gifUrl = null;
$('#gif2mp4').onclick = () => run(async () => {   // GIF -> MP4 first, then the converted clip becomes the patient so every treatment works on it
  if (!patient || !patient.info || !patient.info.isGif) throw new Error('Choose a GIF first.');
  const src = patient.file, R0 = ST.defaultRecipe(); R0.out.crf = 16;
  setCur('Converting the GIF…');
  const r = await treat(src, 'hosp_conv.mp4', R0, 'convert', { ...baseProf(), preset: engine.kind === 'native' ? 'fast' : 'veryfast' });
  const f = new File([r.data], stemOf(src.name) + '.mp4', { type: 'video/mp4' });
  if (gifUrl) URL.revokeObjectURL(gifUrl); gifUrl = URL.createObjectURL(f);
  await choose(f, true);
  const a = $('#gifdl'); a.href = gifUrl; a.download = f.name; $('#gifdone').classList.remove('hide');
  $('#msg').textContent = T('Done. This is now an MP4. Choose your treatments below.');
});

function examine() {
  const i = patient.info, lp = patient.loop;
  const verdict = lp ? (lp.verdict === 'seamless' ? '<span class="chip good">loops ✓</span>' : lp.verdict === 'almost' ? '<span class="chip bad">almost loops</span>' : '<span class="chip bad">jumps</span>') : '';
  $('#facts').innerHTML = `<span>${i.width}×${i.height}</span><span>${Math.round(i.fps * 100) / 100} fps</span><span>${Math.round(i.duration * 10) / 10} s</span><span>${fmtSize(patient.file.size)}</span><span>${esc(i.codec || '')}</span>${verdict}`;
  const d = ST.diagnose(i, lp, { slowEngine: engine.kind !== 'native' });
  $('#findings').innerHTML = d.length ? d.map((x, n) => `<li><span>${esc(x.text)}</span>${Object.keys(x.fix).length ? `<button class="sm" data-fix="${n}" type="button">Add this treatment</button>` : ''}</li>`).join('')
    : '<li class="ok"><span>Nothing wrong found. This clip is ready for the mixers.</span></li>';
  $('#gifbar').classList.toggle('hide', !i.isGif);
  patient.findings = d; $('#healall').classList.toggle('hide', !d.some(x => Object.keys(x.fix).length));
  info();
}
$('#findings').onclick = e => { const b = e.target.closest('[data-fix]'); if (!b) return; ST.mergeRecipe(R, patient.findings[+b.dataset.fix].fix); syncUI(); b.disabled = true; };
$('#healall').onclick = () => { patient.findings.forEach(x => ST.mergeRecipe(R, x.fix)); syncUI(); $('#findings').querySelectorAll('[data-fix]').forEach(b => b.disabled = true); };

$('#pick').onclick = () => $('#picker').click();
$('#picker').onchange = e => { choose(e.target.files[0]); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => choose([...(e.dataTransfer.files || [])][0]));

// ---------------------------------------------------------------------------------------------- treating
const baseProf = () => ({ ...defaultProfile(), preset: engine.kind === 'native' ? 'fast' : 'veryfast', maxFps: 60 });
const setBusy = b => {
  busy = b; ['prev', 'go', 'pickmore', 'healall'].forEach(i => { const e = $('#' + i); if (e) e.disabled = b; });
  $('#stop').classList.toggle('hide', !b); $('#bar').classList.toggle('hide', !b); if (!b) { $('#pausebtn').classList.add('hide'); pauseReq = false; } else $('#pausebtn').classList.toggle('hide', units.total < 2);
};
// One bar for the whole run (all looks of all clips), never backwards; stripes while nothing is known yet.
let units = { done: 0, total: 1 }, best = 0, pauseReq = false;
const prog = x => {
  best = Math.max(best, Math.min(1, (units.done + clamp01(x)) / units.total));
  $('#bar i').style.width = Math.round(best * 1000) / 10 + '%'; $('#bar').classList.toggle('ind', best < 0.002 && !pauseReq);
};
async function waitPause() {   // pause takes effect between clips/looks: a pass that is running cannot be frozen
  if (!pauseReq) return;
  const t = Date.now(); $('#bar').classList.add('pz'); $('#bar').classList.remove('ind'); $('#pausebtn').textContent = T('Resume');
  try { while (pauseReq) { ctl.check(); $('#cur').textContent = T('Paused') + ' · ' + curLabel; await new Promise(r => setTimeout(r, 200)); } }
  finally { $('#bar').classList.remove('pz'); pausedMs += Date.now() - t; $('#pausebtn').textContent = T('Pause after this clip'); }
}
let pausedMs = 0;
async function treat(file, out, rec, label, base) {
  let path; ctl = ctl || { cancel: false, check() { if (this.cancel) throw new Error('cancelled'); } };
  try {
    path = await openInput(file);
    const inf = await L.probe(engine, path, file.name); if (!inf.width) throw new Error('No picture found in this file');
    const r = await ST.runRecipe(engine, L, path, out, inf, rec, base || baseProf(), { ctl, onProgress: prog, tmp: 'hosp_tmp_' + nextId + '.mp4',
      onStage: (kind, sec, i) => setCur(T(kind === 'up' ? 'AI upscaling…' : 'AI slow motion…') + (i && i.gpu ? ' · ' + i.gpu : '') + (i && i.soft ? ' · ' + T('Only a software graphics driver was found. AI will be very slow. Install the Vulkan driver for your graphics card.') : '')) });
    const data = await engine.read(out); await engine.remove(out);
    return { data, note: r.note };
  } finally { if (path) await engine.unmount(path); }
}
let curLabel = '';
const setCur = s => { curLabel = s; $('#cur').textContent = s; };
async function run(fn) {
  if (busy) return; $('#msg').textContent = ''; best = 0; pausedMs = 0; pauseReq = false; setBusy(true); prog(0); ctl = { cancel: false, check() { if (this.cancel) throw new Error('cancelled'); } };
  const c = ctl, t0 = Date.now(), started = t0;   // a clock, so you can see that it is working even when the browser reports no progress
  const tick = setInterval(() => {
    if (pauseReq && $('#bar').classList.contains('pz')) return;
    const s = Math.round((Date.now() - t0 - pausedMs) / 1000), left = best >= 0.03 && s >= 8 && best < 1 ? ' · ' + T('about {a} left').replace('{a}', fmtDur(s * (1 - best) / best)) : '';
    $('#cur').textContent = curLabel + (best > 0 ? ' · ' + Math.floor(best * 100) + '%' : '') + ' · ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + left + (s >= 60 && best < 0.5 ? ' — ' + T('Still working. Slow motion and loop fixes are heavy for a browser, especially on a phone. Short clips finish sooner.') : '');
  }, 1000);
  try { await ensureEngine(); await fn(); } catch (e) { $('#msg').textContent = (c.cancel || e.message === 'cancelled') ? T('Stopped.') : e.message; }
  clearInterval(tick); setBusy(false); ctl = null; setCur('');
}
$('#pausebtn').onclick = () => { pauseReq = !pauseReq; $('#pausebtn').textContent = pauseReq ? T('Resume') : T('Pause after this clip'); };
$('#stop').onclick = () => { if (ctl) ctl.cancel = true; engine.terminate(); setCur(T('Stopping…')); };

$('#prev').onclick = () => run(async () => {
  if (!patient || !patient.info) throw new Error('Choose a clip first.');
  // Small but long enough to judge the loop seam and the life effects: low resolution (cheap), a few seconds of the
  // clip, then the normal loop / life / repeat steps, so the preview runs for 12 to 20 seconds and loops in the player.
  const rec = JSON.parse(JSON.stringify(ST.variants(R)[0].rec)), cap = rec.slow.on ? 4 : 8;
  rec.cut = { on: true, start: rec.cut.on ? rec.cut.start : 0, len: Math.min(rec.cut.on && rec.cut.len > 0 ? rec.cut.len : cap, cap) };
  const aiSlow = rec.slow.on && rec.slow.engine === 'ai'; if (aiSlow) rec.slow.engine = 'blend';
  const notUp = rec.up.on; rec.up.on = false; rec.size = { on: true, box: '480x270', fit: 'keep', upscale: false };
  rec.out.minSeconds = Math.min(20, Math.max(12, rec.out.minSeconds || 0)); rec.out.crf = 28;
  setCur('Making a preview…');
  const r = await treat(patient.file, 'hosp_prev.mp4', rec, 'preview', { ...baseProf(), preset: 'ultrafast' });
  const v = $('#vafter'); if (v.src) URL.revokeObjectURL(v.src); v.src = URL.createObjectURL(new Blob([r.data], { type: 'video/mp4' })); $('#fafter').classList.remove('hide');
  $('#msg').textContent = T(notUp ? 'Preview done. It is small and low quality, but shows the loop and life effects. It does not show the upscale.' : 'Preview done. It is small and low quality, but shows the loop and life effects. The saved file uses your chosen size.') + (aiSlow ? ' ' + T('The preview uses the fast slow-motion method, not AI.') : '');
});

$('#aiprev').onclick = () => run(async () => {   // the real AI on a couple of seconds: shows the quality and how long the whole clip will take
  if (!patient || !patient.info) throw new Error('Choose a clip first.');
  const rec = JSON.parse(JSON.stringify(ST.variants(R)[0].rec)), cap = 2, st = rec.cut.on ? rec.cut.start : 0;
  rec.cut = { on: true, start: st, len: Math.min(rec.cut.on && rec.cut.len > 0 ? rec.cut.len : cap, cap) };
  rec.out.minSeconds = 0; rec.loop.on = false; rec.life.on = false; rec.out.crf = 23;
  setCur(T('Making an AI sample…')); const t0 = Date.now();
  const r = await treat(patient.file, 'hosp_prev.mp4', rec, 'preview', { ...baseProf(), preset: 'ultrafast' });
  const took = (Date.now() - t0) / 1000, whole = Math.max(1, (patient.info.duration || cap) - st) / cap;
  const v = $('#vafter'); if (v.src) URL.revokeObjectURL(v.src); v.src = URL.createObjectURL(new Blob([r.data], { type: 'video/mp4' })); $('#fafter').classList.remove('hide');
  $('#msg').textContent = T('AI sample done in {a}. The whole clip would take about {b}, plus the other steps.').replace('{a}', fmtDur(took)).replace('{b}', fmtDur(took * whole));
});

function addResult(name, data, note) {
  const blob = new Blob([data], { type: 'video/mp4' });
  RESULTS.push({ id: nextId++, name, blob, size: data.length, note, url: URL.createObjectURL(blob) });
  $('#res').innerHTML = RESULTS.map(r => `<div class="rr"><a href="${r.url}" download="${esc(r.name)}">${esc(r.name)} <small class="muted">${fmtSize(r.size)}${r.note ? ' · ' + esc(r.note) : ''}</small></a><button class="sm" data-up="${r.id}" type="button">Upload…</button></div>`).join('');
  $('#more').classList.remove('hide'); $('#zipall').classList.toggle('hide', RESULTS.length < 2);
}
const outName = (f, suffix) => stemOf(f.name).replace(/\s+/g, '_') + (suffix ? '_' + suffix : '') + '_healed.mp4';
const lookName = id => (FILTERS.find(x => x.id === id) || {}).name || id;
// treat one clip once for every look picked (or just once), adding every finished file to the results
async function treatClip(file, label) {
  const vs = ST.variants(R); let n = 0;
  for (const v of vs) {
    ctl.check(); await waitPause(); ctl.check(); n++;
    setCur(label + (vs.length > 1 ? ` · ${v.suffix ? lookName(v.suffix) : T('No look')} (${n}/${vs.length})` : ''));
    const r = await treat(file, `hosp_${nextId}.mp4`, v.rec, 'clip');
    addResult(outName(file, v.suffix), r.data, r.note); units.done++; prog(0);
  }
}
$('#go').onclick = () => run(async () => {
  if (!patient || !patient.info) throw new Error('Choose a clip first.');
  units = { done: 0, total: ST.variants(R).length }; $('#pausebtn').classList.toggle('hide', units.total < 2);
  await treatClip(patient.file, patient.file.name);
  const v = $('#vafter'); if (v.src) URL.revokeObjectURL(v.src); v.src = URL.createObjectURL(RESULTS[RESULTS.length - 1].blob); $('#fafter').classList.remove('hide'); $('#fafter figcaption').textContent = 'After';
});
$('#res').onclick = e => { const b = e.target.closest('[data-up]'); const r = b && RESULTS.find(x => x.id === +b.dataset.up); if (r && window.SPK_UP) SPK_UP.open(new File([r.blob], r.name, { type: 'video/mp4' }), { title: stemOf(r.name).replace(/_healed$/, ''), name: r.name }); };
$('#pickmore').onclick = () => $('#pickermore').click();
$('#pickermore').onchange = e => {
  const files = [...e.target.files].filter(okFile); e.target.value = ''; if (!files.length) return;
  run(async () => {
    let n = 0, bad = 0; const per = ST.variants(R).length; units = { done: 0, total: files.length * per }; $('#pausebtn').classList.toggle('hide', units.total < 2);
    for (const f of files) {
      ctl.check();
      try { await treatClip(f, `${f.name} (${++n}/${files.length})`); }
      catch (er) { if (er.message === 'cancelled') throw er; bad++; units.done = Math.min(units.total, n * per); prog(0); $('#msg').textContent = `${f.name}: ${er.message}`; }
    }
    if (!bad) $('#msg').textContent = '';
  });
};
$('#zipall').onclick = async () => {
  try { const z = await makeZip(RESULTS.map(r => ({ name: r.name, blob: r.blob }))), u = URL.createObjectURL(z), a = document.createElement('a'); a.href = u; a.download = 'healed-loops.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 60000); }
  catch (e) { $('#msg').textContent = e.message; }
};

buildSteps(); info();
window.HOSP = { R, choose, ST };   // for tests and the console
