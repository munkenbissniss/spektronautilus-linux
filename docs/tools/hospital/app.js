import { VIDEO_EXT, GIF_EXT, extOf, stemOf, defaultProfile, fmtSize } from '../app/core.js';
import { FILTERS } from '../app/filters.js';
import { getEngine } from '../app/engine.js';
import * as L from '../app/loops.js';
import * as ST from '../app/steps.js';
import { makeZip } from '../app/zip.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const engine = getEngine(), T = s => (window.SPK_T ? window.SPK_T(s) : s);
const R = ST.defaultRecipe();
const OK_EXT = new Set([...VIDEO_EXT, ...GIF_EXT]);
let patient = null, busy = false, ctl = null, RESULTS = [], nextId = 1;

// ---------------------------------------------------------------------------------------------- the treatment steps
const num = (k, l, h) => ({ k, t: 'number', l, h });
const sel = (k, l, o, n) => ({ k, t: 'select', l, o, n });
const STEPS = [
  { s: 'cut', title: 'Cut', hint: 'Remove the start or the end of the clip.', f: [num('start', 'Start at (seconds)', 'Cuts this much off the beginning.'), num('len', 'Length (seconds)', '0 = until the end of the clip.')] },
  { s: 'crop', title: 'Crop to a shape', hint: 'Cut the picture to the shape you need.', f: [
    sel('shape', 'Cut to the shape', [['169', 'Widescreen 16:9'], ['916', 'Vertical 9:16 (phone, stories)'], ['11', 'Square 1:1'], ['43', '4:3'], ['219', 'Ultra-wide 21:9']]),
    sel('pos', 'Keep which part', [['c', 'The middle'], ['a', 'The start (left or top)'], ['z', 'The end (right or bottom)']])] },
  { s: 'slow', title: 'Slow motion', hint: 'Make the clip slower, or smoother.', f: [
    sel('engine', 'Method', [['blend', 'Soft blend (fast, works everywhere)'], ['motion', 'Smooth motion (slower, cleaner on fast movement)']]),
    sel('factor', 'How much slower', [['2', '2× slower'], ['4', '4× slower'], ['8', '8× slower']], 1),
    sel('mode', 'Result', [['slow', 'Slow motion (the clip gets longer)'], ['smooth', 'Same speed, but smoother (more frames per second)']])] },
  { s: 'up', title: 'Upscale', hint: 'Make the picture larger and sharper.', f: [
    sel('scale', 'Make it this much bigger', [['2', '2× (double)'], ['3', '3× (triple)'], ['4', '4× (four times)']], 1),
    { k: 'sharp', t: 'range', l: 'Sharpness', min: 0, max: 100, step: 5 }] },
  { s: 'size', title: 'Resize', hint: 'Fit the clip to a size box. Portrait clips are turned automatically.', f: [
    sel('box', 'Size', ['1280x720', '1920x1080', '2560x1440', '3840x2160']),
    sel('fit', 'Fit', [['keep', 'Keep shape, only shrink'], ['fit', 'Letterbox to exactly the box'], ['fill', 'Crop to exactly the box']]),
    { k: 'upscale', t: 'bool', l: 'Enlarge small videos up to the box' }] },
  { s: 'look', title: 'Look', hint: 'Give the clip a style.', f: [sel('id', 'Look', FILTERS.map(f => [f.id, f.name])), { k: 'amount', t: 'range', l: 'Strength', min: 0, max: 100, step: 1 }] },
  { s: 'loop', title: 'Make it loop', hint: 'Hide the jump where the clip starts over.', f: [
    sel('mode', 'Method', [['auto', 'Auto: keep good loops, otherwise fix them'], ['pingpong', 'Forward, then backward'], ['crossfade', 'Crossfade end into start'], ['trim', 'Trim to the best loop point']]),
    { k: 'fade', t: 'range', l: 'Crossfade length (s)', min: 0.3, max: 8, step: 0.1 }] },
];
const OUT = [sel('fps', 'Frames per second', [['0', 'Keep (snapped to 24/25/30/50/60)'], ['24', '24'], ['25', '25'], ['30', '30'], ['50', '50'], ['60', '60']], 1),
  { k: 'crf', t: 'range', l: 'Quality (lower = better, larger)', min: 12, max: 28, step: 1 },
  { k: 'minSeconds', t: 'range', l: 'Repeat until at least (s)', min: 0, max: 120, step: 1, h: 'Whole loops are repeated. 0 = off. The Magic Video Mixer likes 16 s and longer.' }];

function field(s, f) {
  const id = `h_${s}_${f.k}`, v = R[s][f.k];
  let c;
  if (f.t === 'range') c = `<div class="ctl"><input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${v}" data-s="${s}" data-k="${f.k}"><output>${v}</output></div>`;
  else if (f.t === 'select') c = `<select id="${id}" data-s="${s}" data-k="${f.k}"${f.n ? ' data-num="1"' : ''}>${f.o.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}"${String(ov) === String(v) ? ' selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
  else if (f.t === 'bool') c = `<label style="display:flex;gap:6px;align-items:center"><input id="${id}" type="checkbox" data-s="${s}" data-k="${f.k}"${v ? ' checked' : ''}> <span style="font-size:.9rem">${esc(f.l)}</span></label>`;
  else c = `<input id="${id}" type="number" min="0" step="0.1" value="${v}" data-s="${s}" data-k="${f.k}">`;
  return `<div class="f">${f.t === 'bool' ? '' : `<label for="${id}">${esc(f.l)}</label>`}${c}${f.h ? `<div class="h">${esc(f.h)}</div>` : ''}</div>`;
}
function buildSteps() {
  $('#steps').innerHTML = STEPS.map(st => `<div class="step" data-step="${st.s}"><label><input type="checkbox" data-use="${st.s}"${R[st.s].on ? ' checked' : ''}> ${esc(st.title)}</label><div class="hint" style="margin-left:26px">${esc(st.hint)}</div><div class="fields ${R[st.s].on ? '' : 'hide'}">${st.f.map(f => field(st.s, f)).join('')}</div></div>`).join('');
  $('#outf').innerHTML = OUT.map(f => field('out', f)).join('');
}
function syncUI() {   // push the recipe into the inputs after a suggestion was added
  document.querySelectorAll('[data-s]').forEach(e => { const v = R[e.dataset.s][e.dataset.k]; if (e.type === 'checkbox') e.checked = !!v; else { e.value = String(v); const o = e.nextElementSibling; if (e.type === 'range' && o) o.textContent = e.value; } });
  document.querySelectorAll('[data-use]').forEach(e => { e.checked = !!R[e.dataset.use].on; e.closest('.step').querySelector('.fields').classList.toggle('hide', !R[e.dataset.use].on); });
  info();
}
function info() {
  const on = STEPS.filter(s => R[s.s].on).map(s => s.title);
  $('#info').textContent = on.length ? on.join(' · ') : 'No treatment ticked yet. The clip is only made VJ-friendly.';
}
$('#steps').addEventListener('change', e => {
  const u = e.target.dataset.use; if (u) { R[u].on = e.target.checked; e.target.closest('.step').querySelector('.fields').classList.toggle('hide', !e.target.checked); info(); }
});
function onField(e) {
  const t = e.target, s = t.dataset.s, k = t.dataset.k; if (!s) return;
  const v = t.type === 'checkbox' ? t.checked : (t.type === 'range' || t.type === 'number' || t.dataset.num) ? Number(t.value) : t.value;
  R[s][k] = v; if (t.type === 'range' && t.nextElementSibling) t.nextElementSibling.textContent = t.value;
  if (s === 'slow' && k === 'engine') R.slow.engine = t.value;
}
document.addEventListener('input', onField); document.addEventListener('change', onField);

// ---------------------------------------------------------------------------------------------- engine and files
const status = t => { $('#engine').textContent = t || ''; };
async function ensureEngine() { if (engine.pick) { try { await engine.pick(); } catch (e) { /* the web engine loads below */ } } await engine.load(status); status(''); }
const openInput = async file => engine.mount(new File([file], 'src' + (extOf(file.name) || '.mp4'), { type: file.type }));
const okFile = f => OK_EXT.has(extOf(f.name));

async function choose(file) {
  if (!file) return;
  if (!okFile(file)) { $('#msg').textContent = 'That is not a video type I know.'; return; }
  if (patient) URL.revokeObjectURL(patient.url);
  patient = { file, url: URL.createObjectURL(file), info: null, loop: null };
  $('#vbefore').src = patient.url; $('#patient').classList.remove('hide'); $('#fafter').classList.add('hide'); $('#vafter').removeAttribute('src');
  ['c2', 'c3', 'c4'].forEach(i => $('#' + i).classList.remove('hide')); $('#res').innerHTML = ''; RESULTS = []; $('#more').classList.add('hide'); $('#msg').textContent = '';
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
function examine() {
  const i = patient.info, lp = patient.loop;
  const verdict = lp ? (lp.verdict === 'seamless' ? '<span class="chip good">loops ✓</span>' : lp.verdict === 'almost' ? '<span class="chip bad">almost loops</span>' : '<span class="chip bad">jumps</span>') : '';
  $('#facts').innerHTML = `<span>${i.width}×${i.height}</span><span>${Math.round(i.fps * 100) / 100} fps</span><span>${Math.round(i.duration * 10) / 10} s</span><span>${fmtSize(patient.file.size)}</span><span>${esc(i.codec || '')}</span>${verdict}`;
  const d = ST.diagnose(i, lp);
  $('#findings').innerHTML = d.length ? d.map((x, n) => `<li><span>${esc(x.text)}</span>${Object.keys(x.fix).length ? `<button class="sm" data-fix="${n}" type="button">Add this treatment</button>` : ''}</li>`).join('')
    : '<li class="ok"><span>Nothing wrong found. This clip is ready for the mixers.</span></li>';
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
  $('#stop').classList.toggle('hide', !b); $('#bar').classList.toggle('hide', !b);
};
const prog = x => { $('#bar i').style.width = Math.round(Math.max(0, Math.min(1, x)) * 100) + '%'; };
async function treat(file, out, rec, label, base) {
  let path; ctl = ctl || { cancel: false, check() { if (this.cancel) throw new Error('cancelled'); } };
  try {
    path = await openInput(file);
    const inf = await L.probe(engine, path, file.name); if (!inf.width) throw new Error('No picture found in this file');
    const r = await ST.runRecipe(engine, L, path, out, inf, rec, base || baseProf(), { ctl, onProgress: prog, tmp: 'hosp_tmp_' + nextId + '.mp4' });
    const data = await engine.read(out); await engine.remove(out);
    return { data, note: r.note };
  } finally { if (path) await engine.unmount(path); }
}
async function run(fn) {
  if (busy) return; $('#msg').textContent = ''; setBusy(true); prog(0); ctl = { cancel: false, check() { if (this.cancel) throw new Error('cancelled'); } };
  try { await ensureEngine(); await fn(); } catch (e) { $('#msg').textContent = e.message === 'cancelled' ? 'Stopped.' : e.message; }
  setBusy(false); ctl = null; $('#cur').textContent = '';
}
$('#stop').onclick = () => { if (ctl) ctl.cancel = true; engine.terminate(); $('#cur').textContent = 'Stopping…'; };

$('#prev').onclick = () => run(async () => {
  if (!patient || !patient.info) throw new Error('Choose a clip first.');
  const rec = JSON.parse(JSON.stringify(R)), cap = rec.slow.on ? 2 : 4;   // a short, small try-out: no upscale, at most a few seconds
  rec.cut = { on: true, start: rec.cut.on ? rec.cut.start : 0, len: Math.min(rec.cut.on && rec.cut.len > 0 ? rec.cut.len : cap, cap) };
  const notUp = rec.up.on; rec.up.on = false; rec.size = { on: true, box: '640x360', fit: 'keep', upscale: false }; rec.out.minSeconds = 0; rec.out.crf = 23;
  $('#cur').textContent = 'Making a preview…';
  const r = await treat(patient.file, 'hosp_prev.mp4', rec, 'preview', { ...baseProf(), preset: 'ultrafast' });
  const v = $('#vafter'); if (v.src) URL.revokeObjectURL(v.src); v.src = URL.createObjectURL(new Blob([r.data], { type: 'video/mp4' })); $('#fafter').classList.remove('hide');
  $('#msg').textContent = notUp ? 'Preview done. It is small and short, and does not show the upscale.' : '';
});

function addResult(name, data, note) {
  const blob = new Blob([data], { type: 'video/mp4' });
  RESULTS.push({ id: nextId++, name, blob, size: data.length, note, url: URL.createObjectURL(blob) });
  $('#res').innerHTML = RESULTS.map(r => `<a href="${r.url}" download="${esc(r.name)}">${esc(r.name)} <small class="muted">${fmtSize(r.size)}${r.note ? ' · ' + esc(r.note) : ''}</small></a>`).join('');
  $('#more').classList.remove('hide'); $('#zipall').classList.toggle('hide', RESULTS.length < 2);
}
const outName = f => stemOf(f.name).replace(/\s+/g, '_') + '_healed.mp4';
$('#go').onclick = () => run(async () => {
  if (!patient || !patient.info) throw new Error('Choose a clip first.');
  $('#cur').textContent = patient.file.name;
  const r = await treat(patient.file, `hosp_${nextId}.mp4`, R, 'clip');
  addResult(outName(patient.file), r.data, r.note);
  const v = $('#vafter'); if (v.src) URL.revokeObjectURL(v.src); v.src = URL.createObjectURL(RESULTS[RESULTS.length - 1].blob); $('#fafter').classList.remove('hide'); $('#fafter figcaption').textContent = 'After';
});
$('#pickmore').onclick = () => $('#pickermore').click();
$('#pickermore').onchange = e => {
  const files = [...e.target.files].filter(okFile); e.target.value = ''; if (!files.length) return;
  run(async () => {
    let n = 0, bad = 0;
    for (const f of files) {
      ctl.check(); $('#cur').textContent = `${f.name} (${++n}/${files.length})`; prog(0);
      try { const r = await treat(f, `hosp_${nextId}.mp4`, R, f.name); addResult(outName(f), r.data, r.note); }
      catch (er) { if (er.message === 'cancelled') throw er; bad++; $('#msg').textContent = `${f.name}: ${er.message}`; }
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
