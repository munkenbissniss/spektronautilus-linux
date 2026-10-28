import { VIDEO_EXT, GIF_EXT, extOf, stemOf, defaultProfile, defaultNaming, makeName, encodeArgs, repeatsNeeded, natCompare, fmtSize, targetSize, cropFor, SIZE_STEPS, PRO_FORMATS } from './core.js';
import * as CAT from './catalogue.js';
import { FILTERS, filterChain } from './filters.js';
import { getEngine } from './engine.js';
import * as Q from '../../shared/queue.js';
import * as L from './loops.js';
import * as SR from './search.js';
import { makeZip } from './zip.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const engine = getEngine();
class Cancelled extends Error {}
class Ctl { constructor() { this.cancel = false; } check() { if (this.cancel) throw new Cancelled('cancelled'); } }

const TOOLS = {
  convert: { label: 'Convert', sub: 'Bulk convert mov, webm, mkv, gif … to VJ-friendly mp4, with bulk file naming. Everything runs in your browser.', go: 'Convert', gif: false },
  gif2mp4: { label: 'GIF → MP4', sub: 'Bulk convert GIF files to mp4 that VJ software can play smoothly.', go: 'Convert GIFs', gif: true },
  loop: { label: 'Make loops', sub: 'Turns clips into seamless loops: checks the loop point, then trims, plays forward + backward, or crossfades.', go: 'Make loops', gif: false },
  filters: { label: 'Filters', sub: 'Adds VJ-style looks to many loops at once: glow, glitch, mirror, kaleidoscope and more.', go: 'Apply looks', gif: false },
  crop: { label: 'Crop & trim', sub: 'Cut clips to the shape you need (widescreen, vertical, square) and trim the start and the end.', go: 'Crop and trim', gif: false },
  sizes: { label: 'Sizes', sub: 'Make several sizes of every clip at once: a small proxy for editing, 720p, 1080p, 4K.', go: 'Make sizes', gif: false },
  pro: { label: 'HAP / ProRes', sub: 'Professional formats for Resolume, VDMX, Millumin and video editors. Needs the Linux (local) version.', go: 'Export', gif: false },
  ai: { label: 'AI upscale', sub: 'Make video clips sharper and larger with AI (Video2X). Needs the Linux (local) version, a graphics card with Vulkan and the free program Video2X.', go: 'Upscale', gif: false },
  catalog: { label: 'Catalogue', sub: 'A list of all your loops with picture, length, size and loop quality, as a web page and a spreadsheet file.', go: 'Make catalogue', gif: false },
  pack: { label: 'Loop pack', sub: 'Bundle loops into one zip that is ready to share: preview picture, info file, credits and licence.', go: 'Build pack', gif: false },
  search: { label: 'Find loops', sub: 'Search free sources for loops, download them and convert them to VJ-friendly clips.', go: 'Download and convert selected', gif: false },
};
let tool = 'convert'; try { tool = localStorage.getItem('vj_tool') || 'convert'; } catch (e) { /* ignore */ }
if (TOOLS[location.hash.slice(1)]) tool = location.hash.slice(1);
if (!TOOLS[tool]) tool = 'convert';
const FILE_TOOLS = Object.keys(TOOLS).filter(k => k !== 'search'), FILES = {}, SEL = {};
FILE_TOOLS.forEach(k => { FILES[k] = []; SEL[k] = new Set(); });
const SSEL = new Set(['720', '1080']);   // chosen sizes in the Sizes tool
const FSEL = new Set(), FIMG = {};
let RES = [], RSEL = new Set(), SRCSEL = new Set(), nextId = 1;
const JOBS = [];

const GROUPS = [
  { g: 'VJ-friendly output', open: true, tools: 'convert gif2mp4 loop filters search crop sizes pro', f: [
    { k: 'size', hf: 'sizes', t: 'select', o: ['1280x720', '1920x1080', '2560x1440', '3840x2160'], h: 'The size box. Portrait material is turned automatically. In the browser, 1920×1080 or smaller is wise.' },
    { k: 'fit', hf: 'sizes', t: 'select', o: [['keep', 'Keep shape, only shrink'], ['fit', 'Letterbox to exactly the box'], ['fill', 'Crop to exactly the box']] },
    { k: 'upscale', hf: 'sizes', t: 'bool', l: 'Enlarge small videos up to the box', h: 'Only with “Keep shape”. Good for tiny GIFs.' },
    { k: 'fps', t: 'select', num: 1, o: [['0', 'Keep (snapped to 24/25/30/50/60)'], ['24', '24'], ['25', '25'], ['30', '30'], ['50', '50'], ['60', '60']] },
    { k: 'crf', hf: 'pro', t: 'range', min: 12, max: 28, step: 1, l: 'Quality (lower = better, larger)' },
    { k: 'preset', hf: 'pro', t: 'select', o: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'], h: 'The browser is slower than the desktop version. veryfast is a good balance.' },
    { k: 'gop', hf: 'pro', t: 'range', min: 1, max: 120, step: 1, l: 'Keyframe every (frames)', h: 'Short = smooth scrubbing and looping in VJ software.' },
    { k: 'minSeconds', hf: 'crop', t: 'range', min: 0, max: 120, step: 1, l: 'Repeat until at least (s)', h: 'Whole loops are repeated. 0 = off. The Magic Video Mixer likes 16 s and longer.' },
    { k: 'bg', t: 'text', l: 'Background for transparent GIFs', h: 'black, white or #rrggbb' },
    { k: 'keepAudio', t: 'bool', l: 'Keep sound', h: 'Off by default: loops normally have no sound.' }] },
  { g: 'Crop and trim', open: true, tools: 'crop', f: [
    { k: 'cropShape', t: 'select', x: 1, l: 'Cut to the shape', o: [['169', 'Widescreen 16:9'], ['916', 'Vertical 9:16 (phone, stories)'], ['11', 'Square 1:1'], ['43', '4:3'], ['219', 'Ultra-wide 21:9'], ['none', 'Keep the shape (only trim)']], h: 'The picture is cut, not squeezed. The size box above sets the largest size.' },
    { k: 'cropPos', t: 'select', x: 1, l: 'Keep which part', o: [['c', 'The middle'], ['a', 'The start (left or top)'], ['z', 'The end (right or bottom)']] },
    { k: 'trimStart', t: 'number', x: 1, l: 'Start at (seconds)', h: 'Cuts this much off the beginning.' },
    { k: 'trimLen', t: 'number', x: 1, l: 'Length (seconds)', h: '0 = until the end of the clip.' }] },
  { g: 'Format', open: true, tools: 'pro', f: [
    { k: 'proFormat', t: 'select', x: 1, l: 'Format', o: Object.entries(PRO_FORMATS).map(([k, v]) => [k, v.label]), h: 'HAP plays smoothly in Resolume, VDMX, Millumin and others, because the graphics card does the work. ProRes is for editors like Final Cut and DaVinci Resolve. Files are .mov and much bigger than mp4.' }] },
  { g: 'AI upscale', open: true, tools: 'ai', f: [
    { k: 'aiModel', t: 'select', x: 1, l: 'Kind of picture', o: [['realesr-animevideov3', 'Cartoons and animation'], ['realesrgan-plus', 'Photos and real film (always 4×)'], ['anime4k', 'Fast, for animation (Anime4K)']] },
    { k: 'aiScale', t: 'select', x: 1, num: 1, l: 'Make it this much bigger', o: [['2', '2× (double)'], ['3', '3× (triple)'], ['4', '4× (four times)']] },
    { k: 'aiCrf', t: 'range', x: 1, min: 12, max: 28, step: 1, l: 'Quality (lower = better, larger)' },
    { k: 'aiGpu', t: 'number', x: 1, l: 'Graphics card number', h: 'Leave on 0 unless you have more than one graphics card.' }] },
  { g: 'Catalogue', open: true, tools: 'catalog', f: [
    { k: 'catTitle', t: 'text', x: 1, l: 'Title', h: 'Shown at the top of the catalogue.' },
    { k: 'checkLoop', t: 'bool', x: 1, l: 'Check which clips loop seamlessly', h: 'Takes a little longer. Clips over a minute are not checked.' }] },
  { g: 'Pack details', open: true, tools: 'pack', f: [
    { k: 'packName', t: 'text', x: 1, l: 'Name of the pack' },
    { k: 'packAuthor', t: 'text', x: 1, l: 'Made by' },
    { k: 'packLicence', t: 'select', x: 1, l: 'Licence', o: CAT.LICENCES.map(l => [l.id, l.label]) },
    { k: 'packNotes', t: 'text', x: 1, l: 'Notes (shown in the info file)', h: 'For example where to buy more, a website or how to credit you.' },
    { k: 'packLoop', t: 'bool', x: 1, l: 'Check which clips loop seamlessly', h: 'Adds a loop mark in the catalogue inside the pack.' }] },
  { g: 'Loop', loop: true, open: true, tools: 'loop', f: [
    { k: 'mode', t: 'select', lp: 1, o: [['auto', 'Auto: keep good loops, otherwise fix them'], ['pingpong', 'Forward, then backward'], ['crossfade', 'Crossfade end into start'], ['trim', 'Trim to the best loop point'], ['none', 'Do nothing (just convert)']], h: 'Auto: a clip that already loops is left alone; if cutting a bit off the end gives a clean loop it does that; otherwise it uses the fallback.' },
    { k: 'fallback', t: 'select', lp: 1, o: [['pingpong', 'Forward, then backward'], ['crossfade', 'Crossfade']], l: 'Auto fallback' },
    { k: 'fade', t: 'range', lp: 1, min: 0.3, max: 8, step: 0.1, l: 'Crossfade length (s)' }] },
  { g: 'Naming', open: true, naming: true, tools: 'convert gif2mp4 loop filters search crop sizes pro ai', f: [
    { k: 'template', t: 'text', n: 1, l: 'Name template', h: 'Tokens: {name} {n} {n2} {n3} {n4} {w} {h} {res} {fps} {dur} {date}' },
    { k: 'prefix', t: 'text', n: 1 }, { k: 'suffix', t: 'text', n: 1 },
    { k: 'start', t: 'number', n: 1, l: 'First number' },
    { k: 'case', t: 'select', n: 1, o: [['keep', 'Keep'], ['lower', 'lowercase'], ['upper', 'UPPERCASE']] },
    { k: 'spaces', t: 'select', n: 1, o: [['_', 'Underscore _'], ['-', 'Dash -'], ['keep', 'Keep spaces']] },
    { k: 'ascii', t: 'bool', n: 1, l: 'Plain letters only (æøå → ae o a)' }] },
  { g: 'Saving', open: true, tools: 'convert gif2mp4 loop filters search crop sizes pro ai', f: [
    { k: 'saveDirect', t: 'bool', x: 1, l: 'Save each file straight into a folder I choose', h: 'Chrome and Edge only. Saves memory with many or big files. Otherwise results stay in the page until you download them.' },
    { k: 'loopify', t: 'select', x: 1, srch: 1, o: [['none', 'Just convert'], ['auto', 'Make them seamless loops (auto)'], ['pingpong', 'Forward, then backward'], ['crossfade', 'Crossfade']], l: 'Downloaded clips' }] },
];
const LABEL = k => k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const HAS_DIR = typeof window.showDirectoryPicker === 'function';

function fld(f) {
  const id = 'o_' + f.k, l = f.l || LABEL(f.k); let c;
  if (f.k === 'saveDirect' && !HAS_DIR) return '';
  if (f.t === 'range') c = `<div class="ctl"><input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}"><output></output></div>`;
  else if (f.t === 'select') c = `<select id="${id}">${f.o.map(o => Array.isArray(o) ? `<option value="${esc(o[0])}">${esc(o[1])}</option>` : `<option>${esc(o)}</option>`).join('')}</select>`;
  else if (f.t === 'bool') c = `<label class="chips"><input id="${id}" type="checkbox"> <span style="font-size:.9rem">${esc(l)}</span></label>`;
  else c = `<input id="${id}" type="${f.t === 'number' ? 'number' : 'text'}">`;
  return `<div class="f${f.srch ? ' srch' : ''}"${f.hf ? ` data-hf="${f.hf}"` : ''}><label for="${id}" ${f.t === 'bool' ? 'class="hide"' : ''}>${esc(l)}</label>${c}${f.h ? `<div class="h">${esc(f.h)}</div>` : ''}</div>`;
}
function buildSettings() {
  $('#groups').innerHTML = GROUPS.map(g => `<details data-g="${g.g}" data-tools="${g.tools || ''}" ${g.open ? 'open' : ''} class="${g.loop ? 'loopg' : ''}"><summary>${g.g}</summary><div class="fields">${g.f.map(fld).join('')}${g.naming ? '<div class="f" style="grid-column:1/-1"><label>Preview</label><div class="prev" id="nprev">Add files to see the new names.</div></div>' : ''}</div></details>`).join('');
  const P = { ...defaultProfile(), preset: 'veryfast' }, N = defaultNaming(), X = { saveDirect: false, loopify: 'none', mode: 'auto', fallback: 'pingpong', fade: 1.5, cropShape: '169', cropPos: 'c', trimStart: 0, trimLen: 0, proFormat: 'hap', aiModel: 'realesr-animevideov3', aiScale: 2, aiCrf: 17, aiGpu: 0, catTitle: 'My loop catalogue', checkLoop: true, packName: 'My loop pack', packAuthor: '', packLicence: 'ccby', packNotes: '', packLoop: true };
  GROUPS.forEach(g => g.f.forEach(f => {
    const e = $('#o_' + f.k); if (!e) return;
    const v = f.n ? N[f.k] : (f.x || f.lp) ? X[f.k] : P[f.k];
    if (e.type === 'checkbox') e.checked = !!v; else e.value = String(v);
    if (e.type === 'range') { const o = e.nextElementSibling; o.textContent = e.value; e.oninput = () => o.textContent = e.value; }
  }));
  $('#groups').addEventListener('input', () => namePrev());
}
const val = f => { const e = $('#o_' + f.k); if (!e) return undefined; return e.type === 'checkbox' ? e.checked : (e.type === 'range' || e.type === 'number' || f.num) ? Number(e.value) : e.value; };
function collect() {
  const profile = {}, naming = {}, loop = {}, ex = {};
  GROUPS.forEach(g => g.f.forEach(f => { const v = val(f); if (v === undefined) return; if (f.n) naming[f.k] = v; else if (f.lp) loop[f.k] = v; else if (f.x) ex[f.k] = v; else profile[f.k] = v; }));
  profile.maxFps = 60;
  if (tool === 'search') loop.mode = ex.loopify;
  return { profile, naming, loop, ex };
}

function setTool(t) {
  tool = t; history.replaceState(null, '', '#' + t); try { localStorage.setItem('vj_tool', t); } catch (e) { /* ignore */ }
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  document.querySelectorAll('[data-for]').forEach(e => e.classList.toggle('hide', !e.dataset.for.split(' ').includes(t)));
  $('#sub').textContent = TOOLS[t].sub; $('#go').textContent = TOOLS[t].go;
  document.querySelectorAll('#groups details[data-tools]').forEach(e => e.classList.toggle('hide', !!e.dataset.tools && !e.dataset.tools.split(' ').includes(t)));
  document.querySelectorAll('#groups [data-hf]').forEach(e => e.classList.toggle('hide', e.dataset.hf.split(' ').includes(t)));
  proNote();
  document.querySelectorAll('.srch').forEach(e => e.classList.toggle('hide', t !== 'search'));
  $('#looptools').classList.toggle('hide', t !== 'loop');
  $('#droptxt').textContent = TOOLS[t].gif ? 'Drop GIF files here' : 'Drop videos here';
  renderFiles(); namePrev(); runInfo(); if (t === 'filters') renderFilters();
}
function runInfo() {
  if (tool === 'filters') { const n = SEL.filters.size; $('#runinfo').textContent = n && FSEL.size ? `${n} file(s) × ${FSEL.size} look(s) = ${n * FSEL.size} new clip(s)` : 'Select files above and pick at least one look'; return; }
  if (tool === 'sizes') { const n = SEL.sizes.size; $('#runinfo').textContent = n && SSEL.size ? `${n} file(s) × ${SSEL.size} size(s)` : 'Select files above and pick at least one size'; return; }
  $('#runinfo').textContent = tool === 'search' ? (RSEL.size ? `${RSEL.size} clip(s) selected` : 'Select search results above') : (SEL[tool].size ? `${SEL[tool].size} of ${FILES[tool].length} file(s) selected` : 'Select files above');
}

// ---------------------------------------------------------------------------------------------- files
const okExt = (n, t = tool) => (TOOLS[t].gif ? GIF_EXT : VIDEO_EXT).has(extOf(n));
function addFiles(list, t = tool) {
  const have = new Set(FILES[t].map(f => f.key)); let skipped = 0;
  for (const file of list) {
    const name = file.webkitRelativePath || file.name;
    if (!okExt(file.name, t)) { skipped++; continue; }
    const key = `${name}|${file.size}|${file.lastModified}`; if (have.has(key)) continue;
    const it = { id: nextId++, key, file, name: file.name, folder: (file.webkitRelativePath || '').split('/').slice(-2, -1)[0] || '', size: file.size, url: URL.createObjectURL(file), meta: null, tag: null };
    FILES[t].push(it); SEL[t].add(it.id);
  }
  FILES[t].sort((a, b) => natCompare(a.name, b.name));
  if (t === tool) { renderFiles(); namePrev(); runInfo(); }
  $('#msg').textContent = skipped ? `${skipped} file(s) skipped (${TOOLS[t].gif ? 'only GIF files here' : 'not a video type I know'}).` : '';
}
function renderFiles() {
  if (tool === 'search') return;
  const Ls = FILES[tool];
  $('#fcount').textContent = Ls.length ? `(${SEL[tool].size} selected of ${Ls.length})` : '';
  $('#files').innerHTML = Ls.map(f => `<div class="vt ${SEL[tool].has(f.id) ? 'sel' : ''}" data-id="${f.id}">${f.name.toLowerCase().endsWith('.gif') ? `<img alt="" src="${f.url}">` : `<video muted preload="metadata" playsinline src="${f.url}#t=0.3"></video>`}${f.tag ? `<span class="tag ${f.tag.cls}" title="${esc(f.tag.text)}">${esc(f.tag.short)}</span>` : ''}<button class="x" data-rm="${f.id}" title="Remove from list">✕</button><div class="cap"><span title="${esc(f.name)}">${esc(f.name)}</span><span>${fmtSize(f.size)}</span></div></div>`).join('') || '<span class="muted">No files yet.</span>';
  $('#files').querySelectorAll('video').forEach((v, i) => {
    const f = Ls[i]; v.onloadedmetadata = () => { f.meta = { width: v.videoWidth, height: v.videoHeight, duration: v.duration }; namePrev(); };
    v.onerror = () => { v.style.visibility = 'hidden'; };
  });
}
$('#files').onclick = e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { const id = +rm.dataset.rm; FILES[tool] = FILES[tool].filter(f => f.id !== id); SEL[tool].delete(id); renderFiles(); namePrev(); runInfo(); return; }
  const t = e.target.closest('.vt'); if (!t) return; const id = +t.dataset.id;
  SEL[tool].has(id) ? SEL[tool].delete(id) : SEL[tool].add(id); t.classList.toggle('sel');
  $('#fcount').textContent = `(${SEL[tool].size} selected of ${FILES[tool].length})`; namePrev(); runInfo();
};
$('#selall').onclick = () => { FILES[tool].forEach(f => SEL[tool].add(f.id)); renderFiles(); namePrev(); runInfo(); };
$('#selnone').onclick = () => { SEL[tool].clear(); renderFiles(); namePrev(); runInfo(); };
$('#clearf').onclick = () => { FILES[tool] = []; SEL[tool].clear(); renderFiles(); namePrev(); runInfo(); };
$('#pick').onclick = () => $('#picker').click();
$('#pickdir').onclick = () => $('#pickerdir').click();
$('#picker').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#pickerdir').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', async e => {
  const items = [...(e.dataTransfer.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (items.some(i => i.isDirectory)) { addFiles(await readEntries(items)); return; }
  addFiles([...e.dataTransfer.files]);
});
async function readEntries(entries) {
  const out = [];
  const walk = async en => {
    if (en.isFile) out.push(await new Promise(r => en.file(r)));
    else { const rd = en.createReader(); for (;;) { const b = await new Promise(r => rd.readEntries(r)); if (!b.length) break; for (const c of b) await walk(c); } }
  };
  for (const en of entries) await walk(en);
  return out;
}

// ---------------------------------------------------------------------------------------------- naming preview
let npT;
function namePrev() {
  clearTimeout(npT);
  npT = setTimeout(() => {
    const el = $('#nprev'); if (!el) return;
    if (tool === 'search') { el.textContent = 'Downloaded clips are named “provider_id” unless you change the template.'; return; }
    const sel = FILES[tool].filter(f => SEL[tool].has(f.id));
    if (!sel.length) { el.textContent = 'Add files to see the new names.'; return; }
    const { naming } = collect(), taken = new Set();
    const fl0 = tool === 'filters' ? (FILTERS.find(x => FSEL.has(x.id)) || FILTERS[0]).id : null, v0 = tool === 'sizes' ? ((SIZE_STEPS.find(z => SSEL.has(z[0])) || SIZE_STEPS[1])[0] + 'p') : tool === 'ai' ? aiVariant(collect().ex) : null;
    const ext = tool === 'pro' ? (PRO_FORMATS[$('#o_proFormat').value] || PRO_FORMATS.hap).ext : '.mp4';
    const rows = sel.map((f, i) => `${f.name}  →  ${makeName(f.name, i, fl0 ? withFilterTemplate(naming) : v0 ? withVariantTemplate(naming) : naming, f.meta, taken, f.folder, fl0 ? { filter: fl0 } : v0 ? { variant: v0 } : {})}${ext}`);
    el.textContent = rows.slice(0, 12).join('\n') + (rows.length > 12 ? `\n… and ${rows.length - 12} more` : '');
  }, 200);
}

// ---------------------------------------------------------------------------------------------- engine status
function engineStatus(t) { $('#engine').textContent = t || ''; }
function nativeBadge() {
  proNote();
  if (engine.kind !== 'native') return;
  $('#ekind').textContent = `Fast mode: using ffmpeg on this computer (${engine.info.cores} cores${engine.info.version ? ', ffmpeg ' + engine.info.version : ''}).`;
  const p = $('#o_preset'); if (p && p.value === 'veryfast') { p.value = 'fast'; p.dispatchEvent(new Event('input', { bubbles: true })); p.dispatchEvent(new Event('change', { bubbles: true })); }
}
function proNote() {
  aiNote();
  const el = $('#pronote'); if (!el) return;
  el.classList.toggle('hide', !(tool === 'pro' && engine.kind !== 'native'));
}
async function ensureEngine() { await engine.load(engineStatus); engineStatus(''); nativeBadge(); }
if (engine.pick) engine.pick().then(nativeBadge).catch(() => {});             // the local (Linux) version is recognised straight away; the web version waits until you start a job

// AI upscale: the name part that says what was done, e.g. clip_ai2x
const aiVariant = ex => 'ai' + (ex.aiModel === 'realesrgan-plus' ? 4 : (+ex.aiScale || 2)) + 'x';
function aiNote() {
  const el = $('#ainote'); if (!el) return;
  el.classList.toggle('hide', tool !== 'ai');
  if (tool !== 'ai') return;
  const native = engine.kind === 'native', v = native && engine.info && engine.info.v2x;
  $('#ainote-t').textContent = !native ? 'AI upscaling needs the Linux (local) version of Spektronautilus. The web version cannot do it. Everything else on this page works in the browser.'
    : v && v.ok ? 'Video2X found: ' + (v.version || v.path) : 'Video2X was not found on this computer. Install it (AppImage, AUR or your own build), or set SPEKTRO_VIDEO2X to its path, then start Spektronautilus again.';
  $('#aigpu').classList.toggle('hide', !(v && v.ok));
}
$('#aigpu').onclick = async () => {
  const out = $('#aigpus'); out.classList.remove('hide'); out.textContent = 'Asking Video2X…'; $('#aigpu').disabled = true;
  try { const r = await engine.v2xGpus(); out.textContent = r && r.ok && r.lines.length ? r.lines.join('\n') : 'Could not ask Video2X about the graphics cards.'; }
  catch (e) { out.textContent = 'Could not ask Video2X about the graphics cards.'; }
  $('#aigpu').disabled = false;
};
try { const l = localStorage.getItem('spk_lang') || 'en'; $('#aiguide').href = '../../' + (l !== 'en' && /^(no|es|de|pt)$/.test(l) ? l + '/' : '') + 'guides/tools/#ai'; } catch (e) { /* ignore */ }

// open one picked File in the engine (read straight from disk, no copy)
async function openInput(file) {
  const safe = new File([file], 'src' + (extOf(file.name) || '.mp4'), { type: file.type });
  const path = await engine.mount(safe);
  return path;
}

// ---------------------------------------------------------------------------------------------- loop check
$('#checkloops').onclick = async () => {
  const sel = FILES.loop.filter(f => SEL.loop.has(f.id)); let i = 0;
  try { await ensureEngine(); } catch (e) { $('#chkmsg').textContent = ' ' + e.message; return; }
  for (const f of sel) {
    $('#chkmsg').textContent = ` Checking ${++i}/${sel.length}…`;
    let path;
    try {
      path = await openInput(f.file);
      const info = await L.probe(engine, path, f.name), r = await L.analyze(engine, path, info);
      f.tag = { short: r.verdict === 'seamless' ? 'loops ✓' : r.verdict === 'almost' ? 'almost' : 'jump', cls: r.verdict === 'seamless' ? 'good' : 'bad', text: L.reportText(r) };
    } catch (e) { f.tag = { short: '?', cls: 'bad', text: e.message }; }
    finally { if (path) await engine.unmount(path); }
    renderFiles();
  }
  $('#chkmsg').textContent = ' Done. Hover a label for details.';
};

// ---------------------------------------------------------------------------------------------- sizes
function renderSizes() {
  $('#sgrid').innerHTML = SIZE_STEPS.map(z => `<label class="srcchip ${SSEL.has(z[0]) ? 'sel' : ''}"><input type="checkbox" data-z="${z[0]}" ${SSEL.has(z[0]) ? 'checked' : ''}>${esc(z[3])}${z[0] === '480' ? '' : ` <small class="muted">${z[1]}×${z[2]}</small>`}</label>`).join('');
}
$('#sgrid').onchange = e => { const z = e.target.dataset.z; if (!z) return; e.target.checked ? SSEL.add(z) : SSEL.delete(z); renderSizes(); namePrev(); runInfo(); };

// ---------------------------------------------------------------------------------------------- search
function renderSrcs() {
  $('#srcs').innerHTML = SR.status().map(s => `<label class="srcchip ${SRCSEL.has(s.name) ? 'sel' : ''} ${s.ready ? '' : 'off'}" title="${s.ready ? '' : 'Needs a free API key – see below'}"><input type="checkbox" data-s="${s.name}" ${SRCSEL.has(s.name) ? 'checked' : ''} ${s.ready ? '' : 'disabled'}>${esc(s.label)}${s.ready ? '' : ' 🔑'}</label>`).join('');
}
$('#srcs').onchange = e => { const s = e.target.dataset.s; if (!s) return; e.target.checked ? SRCSEL.add(s) : SRCSEL.delete(s); renderSrcs(); };
$('#savekeys').onclick = () => { SR.setKey('pexels', $('#k_pexels').value); SR.setKey('pixabay', $('#k_pixabay').value); SR.status().filter(s => s.ready).forEach(s => SRCSEL.add(s.name)); renderSrcs(); $('#keymsg').textContent = 'Saved in this browser.'; };
let SQ = null;   // the search that "Load more" continues
async function doSearch(more = false) {
  const q = more && SQ ? SQ.q : $('#q').value.trim(); if (!q) { $('#smsg').textContent = 'Type what you are looking for.'; return; }
  const page = more && SQ ? SQ.page + 1 : 1;
  $('#smsg').textContent = 'Searching…'; $('#dosearch').disabled = true; $('#more').disabled = true;
  try {
    const o = { loopWord: $('#loopword').checked, minHeight: +$('#minh').value, minSeconds: +$('#mins').value || 0, maxSeconds: +$('#maxs').value || 0, orientation: $('#orient').value, pixabayType: $('#ptype').value, page };
    const r = await SR.search(q, [...SRCSEL], o);
    const have = new Set(RES.map(x => x.provider + ':' + x.id)), fresh = r.results.filter(x => !have.has(x.provider + ':' + x.id));
    if (more) RES = RES.concat(fresh); else { RES = fresh; RSEL = new Set(); }
    SQ = { q, page }; renderResults();
    const er = Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(' · ');
    $('#smsg').innerHTML = (RES.length ? `${RES.length} clips found${more && !fresh.length ? ' (nothing new on this page)' : ''}.` : 'Nothing found. Try other words.') + (er ? ` <span class="warn">${esc(er)}</span>` : '');
  } catch (e) { $('#smsg').textContent = e.message; }
  $('#dosearch').disabled = false; $('#more').disabled = false; runInfo();
}
function renderResults() {
  $('#rtools').classList.toggle('hide', !RES.length); $('#moretools').classList.toggle('hide', !RES.length); $('#rcount').textContent = RES.length ? `${RSEL.size} selected` : '';
  $('#results').innerHTML = RES.map((r, i) => `<div class="rc ${RSEL.has(i) ? 'sel' : ''}" data-i="${i}">${r.thumb ? `<img loading="lazy" referrerpolicy="no-referrer" alt="" src="${esc(r.thumb)}" onerror="this.style.visibility='hidden'">` : '<img alt="">'}<div class="b"><span class="t" title="${esc(r.title)}">${esc(r.title)}</span><span class="muted">${esc(r.provider)} · ${r.height ? r.width + '×' + r.height : 'size ?'} · ${r.duration ? Math.round(r.duration) + ' s' : '? s'}</span><span class="muted" title="${esc(r.author)}">${esc(r.license || 'licence ?')}${r.author ? ' · ' + esc(r.author) : ''}</span>${r.page ? `<a href="${esc(r.page)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-size:.78rem">Open page ↗</a>` : ''}</div></div>`).join('');
}
$('#results').onclick = e => { const c = e.target.closest('.rc'); if (!c) return; const i = +c.dataset.i; RSEL.has(i) ? RSEL.delete(i) : RSEL.add(i); c.classList.toggle('sel'); $('#rcount').textContent = `${RSEL.size} selected`; runInfo(); };
$('#rall').onclick = () => { RES.forEach((_, i) => RSEL.add(i)); renderResults(); runInfo(); };
$('#rnone').onclick = () => { RSEL.clear(); renderResults(); runInfo(); };
$('#dosearch').onclick = () => doSearch(false); $('#more').onclick = () => doSearch(true); $('#q').onkeydown = e => { if (e.key === 'Enter') doSearch(false); };

// ---------------------------------------------------------------------------------------------- filters
function renderFilters() {
  $('#fgrid').innerHTML = FILTERS.map(f => `<div class="ft ${FSEL.has(f.id) ? 'sel' : ''}" data-id="${f.id}" role="button" tabindex="0" aria-pressed="${FSEL.has(f.id)}"><div class="im">${FIMG[f.id] ? `<img alt="${esc(f.name)} preview" src="${FIMG[f.id]}">` : 'no preview yet'}</div><div class="b"><b>${esc(f.name)}</b><span>${esc(f.desc)}</span></div></div>`).join('');
  $('#fcnt').textContent = FSEL.size ? `${FSEL.size} look(s) selected` : '';
}
const toggleFilter = id => { FSEL.has(id) ? FSEL.delete(id) : FSEL.add(id); renderFilters(); namePrev(); runInfo(); };
$('#fgrid').onclick = e => { const t = e.target.closest('.ft'); if (t) toggleFilter(t.dataset.id); };
$('#fgrid').onkeydown = e => { const t = e.target.closest('.ft'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleFilter(t.dataset.id); } };
$('#fall').onclick = () => { FILTERS.forEach(f => FSEL.add(f.id)); renderFilters(); namePrev(); runInfo(); };
$('#fnone').onclick = () => { FSEL.clear(); renderFilters(); namePrev(); runInfo(); };
$('#famt').oninput = () => { $('#famtv').textContent = $('#famt').value; };
$('#fprev').onclick = async () => {
  const f0 = FILES.filters.find(f => SEL.filters.has(f.id)); if (!f0) { $('#fmsg').textContent = 'Add and select a clip first.'; return; }
  $('#fprev').disabled = true; let path;
  try {
    await ensureEngine(); path = await openInput(f0.file);
    const info = await L.probe(engine, path, f0.name), W = 480, H = Math.max(2, Math.round(W * info.height / info.width / 2) * 2), amt = +$('#famt').value;
    const ss = info.duration > 3 ? 1 : 0;
    for (let i = 0; i < FILTERS.length; i++) {
      const f = FILTERS[i]; $('#fmsg').textContent = `Preview ${i + 1}/${FILTERS.length}: ${f.name}…`;
      const out = `pv_${f.id}.png`;
      const r = await engine.exec(['-y', ...(ss ? ['-ss', String(ss)] : []), '-i', path, '-t', '1', '-filter_complex', `[0:v]scale=${W}:${H},fps=25,setsar=1,${filterChain(f.id, amt, { w: W, h: H, dur: info.duration })},format=rgb24[v]`, '-map', '[v]', '-update', '1', out]);
      if (r.code === 0) { const d = await engine.read(out); await engine.remove(out); if (FIMG[f.id]) URL.revokeObjectURL(FIMG[f.id]); FIMG[f.id] = URL.createObjectURL(new Blob([d], { type: 'image/png' })); }
      renderFilters();
    }
    $('#fmsg').textContent = 'Done. Click the looks you like.';
  } catch (e) { $('#fmsg').textContent = e.message; }
  finally { if (path) await engine.unmount(path); $('#fprev').disabled = false; }
};

// ---------------------------------------------------------------------------------------------- jobs
const stems = async dir => { const s = new Set(); for await (const [n] of dir.entries()) s.add(n.replace(/\.[^.]+$/, '').toLowerCase()); return s; };

const withFilterTemplate = nm => (String(nm.template || '').includes('{filter}') ? nm : { ...nm, template: (nm.template || '{name}') + '_{filter}' });
const withVariantTemplate = nm => (String(nm.template || '').includes('{variant}') ? nm : { ...nm, template: (nm.template || '{name}') + '_{variant}' });
async function processOne(job, src, idx, srcName, folder, c, flt, v) {
  // src: File. Returns { name, blob?, size, note }  (or { skip } when a size is not needed)
  const ctl = job.ctl; let path;
  try {
    path = await openInput(src);
    const info = await L.probe(engine, path, srcName);
    if (!info.width) throw new Error('No picture found in this file');
    const PF = job.tool === 'pro' ? PRO_FORMATS[c.ex.proFormat] || PRO_FORMATS.hap : null, ext = PF ? PF.ext : '.mp4';
    if (v) {   // Sizes: a size bigger than the clip itself is not made
      const [bw, bh] = info.height > info.width ? [v.h, v.w] : [v.w, v.h];
      if (info.width < bw * 0.98 && info.height < bh * 0.98) return { skip: `${v.id}p skipped: the clip is only ${info.width}x${info.height}` };
    }
    const aiv = job.tool === 'ai' ? aiVariant(c.ex) : null;
    const nm = flt ? withFilterTemplate(c.naming) : (v || aiv) ? withVariantTemplate(c.naming) : c.naming;
    const base = makeName(srcName, idx, nm, { ...info }, job.taken, folder, flt ? { filter: flt } : v ? { variant: v.id + 'p' } : aiv ? { variant: aiv } : {}), out = `o_${job.id}_${idx}${ext}`;
    const prog = r => { job.progress = (job.finished + r) / job.total; job.dirty = true; };
    let note;
    if (job.tool === 'ai') {
      const plus = c.ex.aiModel === 'realesrgan-plus', sc = plus ? 4 : (+c.ex.aiScale || 2), anime4k = c.ex.aiModel === 'anime4k';
      if (info.width * sc > 7680 || info.height * sc > 7680) throw new Error('The result would be larger than 8K. Choose a smaller scale or a smaller clip.');
      const args = ['-i', path, '-o', out, ...(anime4k ? ['-p', 'libplacebo', '--libplacebo-shader', 'anime4k-v4-a+a', '-w', String(Math.round(info.width * sc / 2) * 2), '-h', String(Math.round(info.height * sc / 2) * 2)]
        : ['-p', 'realesrgan', '--realesrgan-model', c.ex.aiModel, '-s', String(sc)]), '-c', 'libx264', '-e', 'crf=' + Math.round(+c.ex.aiCrf || 17), ...(+c.ex.aiGpu > 0 ? ['-g', String(Math.round(+c.ex.aiGpu))] : [])];
      const t0 = Date.now(), tick = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); job.current = `${srcName} · ` + (window.SPK_T ? window.SPK_T('AI upscaling… {a}').replace('{a}', Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')) : 'AI upscaling… ' + s + ' s'); job.dirty = true; }, 1000);
      let r; try { r = await engine.v2x(args, { onProgress: prog }); } finally { clearInterval(tick); }
      if (r.code !== 0) throw new Error('Could not upscale this file (' + (r.log.filter(l => /error|invalid|fail|not supported|unknown|vulkan/i.test(l)).slice(-1)[0] || 'code ' + r.code).slice(0, 160) + ')');
      note = `${info.width}x${info.height} → ${info.width * sc}x${info.height * sc}`;
    } else if (job.tool === 'crop') {
      const cr = cropFor(info, c.ex.cropShape === 'none' ? '' : c.ex.cropShape, c.ex.cropPos), ts = Math.max(0, +c.ex.trimStart || 0), tl = Math.max(0, +c.ex.trimLen || 0);
      if (info.duration && ts >= info.duration - 0.05) throw new Error('The start time is after the end of this clip');
      const eff = info.duration ? Math.min(info.duration - ts, tl || Infinity) : 0;
      const r = await engine.exec(encodeArgs(path, out, c.profile, { ...info, width: cr.width, height: cr.height, duration: eff }, { pre: cr.filter, seek: ts, limit: tl, extra: '' }), { onProgress: prog });
      if (r.code !== 0) throw new Error('Could not crop this file (' + (r.log.filter(l => /error|invalid|not supported|unknown/i.test(l)).slice(-1)[0] || '') + ')');
      note = `${cr.width}x${cr.height}${ts || tl ? ', trimmed' : ''}`;
    } else if (v) {
      const prof = { ...c.profile, size: `${v.w}x${v.h}`, fit: 'keep', upscale: false };
      const r = await engine.exec(encodeArgs(path, out, prof, info, { repeat: repeatsNeeded(info.duration, prof.minSeconds) }), { onProgress: prog });
      if (r.code !== 0) throw new Error('Could not convert this file (unsupported format? ' + (r.log.filter(l => /error|invalid|not supported|unknown/i.test(l)).slice(-1)[0] || '') + ')');
      const [tw, th] = targetSize(info, prof); note = `${v.id}p: ${tw}x${th}`;
    } else if (PF) {
      const keepA = PF.alpha && info.alpha, prof = { ...c.profile, keepAudio: c.profile.keepAudio };
      const r = await engine.exec(encodeArgs(path, out, prof, info, { repeat: repeatsNeeded(info.duration, prof.minSeconds), extra: PF.mod4 ? 'scale=trunc(iw/4)*4:trunc(ih/4)*4' : '', pix: PF.pix, codec: PF.codec, keepAlpha: keepA, audioCodec: ['-c:a', 'pcm_s16le'] }), { onProgress: prog });
      if (r.code !== 0) throw new Error('Could not export this file (' + (r.log.filter(l => /error|invalid|not supported|unknown|encoder/i.test(l)).slice(-1)[0] || '') + ')');
      note = PF.label.replace(/ \(.*$/, '') + (keepA ? ' with transparency' : '');
    } else if (flt) {
      const [tw, th] = targetSize(info, c.profile), extra = filterChain(flt, c.filterAmount, { w: tw, h: th, dur: info.duration });
      const r = await engine.exec(encodeArgs(path, out, c.profile, info, { repeat: repeatsNeeded(info.duration, c.profile.minSeconds), extra }), { onProgress: prog });
      if (r.code !== 0) throw new Error('Could not apply this look (' + (r.log.filter(l => /error|invalid|not supported|unknown|no such/i.test(l)).slice(-1)[0] || 'unknown error') + ')');
      note = `look: ${flt}`;
    } else if (job.tool === 'loop' || (job.tool !== 'convert' && job.tool !== 'gif2mp4' && c.loop.mode && c.loop.mode !== 'none')) {
      const r = await L.makeLoop(engine, path, out, c.profile, info, { mode: c.loop.mode, fade: c.loop.fade, fallback: c.loop.fallback || 'pingpong', ctl, onProgress: prog });
      note = r.note;
    } else {
      const r = await engine.exec(encodeArgs(path, out, c.profile, info, { repeat: repeatsNeeded(info.duration, c.profile.minSeconds) }), { onProgress: prog });
      if (r.code !== 0) throw new Error('Could not convert this file (unsupported format? ' + (r.log.filter(l => /error|invalid|not supported|unknown/i.test(l)).slice(-1)[0] || '') + ')');
      note = `${info.width}x${info.height} ${info.codec} -> h264`;
    }
    ctl.check();
    const data = await engine.read(out); await engine.remove(out);
    return { name: base + ext, blob: new Blob([data], { type: PF ? 'video/quicktime' : 'video/mp4' }), size: data.length, note };
  } finally { if (path) await engine.unmount(path); }
}

// catalogue and loop pack: read each file (length, size, loop quality, one picture) instead of making a new video
async function inspectOne(job, src, idx, srcName, folder, c) {
  let path;
  try {
    path = await openInput(src);
    const info = await L.probe(engine, path, srcName);
    if (!info.width) throw new Error('No picture found in this file');
    const want = job.tool === 'pack' ? c.ex.packLoop : c.ex.checkLoop;
    let loop = null; if (want && info.duration > 0 && info.duration <= 60) { try { loop = await L.analyze(engine, path, info); } catch (e) { loop = null; } }
    const th = `t_${job.id}_${idx}.jpg`, ss = info.duration > 2 ? Math.min(info.duration / 2, 3) : 0;
    const r = await engine.exec(['-y', ...(ss ? ['-ss', String(ss)] : []), '-i', path, '-frames:v', '1', '-an', '-vf', 'scale=320:-2:flags=area,format=yuvj420p', '-q:v', '5', th]);
    let jpg = null; if (r.code === 0) { try { jpg = await engine.read(th); } catch (e) { jpg = null; } } await engine.remove(th);
    job.progress = (job.finished + 1) / job.total; job.dirty = true;
    return { name: srcName, folder, file: src, size: src.size, info, loop, jpg };
  } finally { if (path) await engine.unmount(path); }
}
async function buildInspectOutputs(job) {
  const c = job.c, rows = job.rows.slice().sort((a, b) => natCompare(a.name, b.name));
  if (job.tool === 'catalog') {
    const title = c.ex.catTitle || 'My loop catalogue';
    const files = [['catalogue.html', new Blob([CAT.html(title, rows)], { type: 'text/html' }), 'open in any browser'], ['catalogue.csv', new Blob([CAT.csv(rows)], { type: 'text/csv' }), 'for Excel, Numbers, Sheets']];
    files.forEach(([name, blob, note]) => job.results.push({ name, blob, size: blob.size, note }));
    return;
  }
  const meta = { name: c.ex.packName || 'My loop pack', author: c.ex.packAuthor, licence: c.ex.packLicence, notes: c.ex.packNotes }, dir = CAT.slug(meta.name), used = new Set(), entries = [];
  const sheet = await CAT.contactSheet(meta.name, `${rows.length} loops${meta.author ? ' · by ' + meta.author : ''}`, rows);
  for (const r of rows) { let n = r.name, k = 2; while (used.has(n.toLowerCase())) n = r.name.replace(/(\.[^.]+)?$/, `-${k++}$1`); used.add(n.toLowerCase()); r.name = n; entries.push({ name: `${dir}/${n}`, blob: r.file }); }
  const add = (n, b) => entries.push({ name: `${dir}/${n}`, blob: b });
  add('README.txt', new Blob([CAT.readme(meta, rows)], { type: 'text/plain' })); add('pack.json', new Blob([CAT.packJson(meta, rows)], { type: 'application/json' }));
  add('index.html', new Blob([CAT.html(meta.name, rows, { author: meta.author, licence: meta.licence, notes: meta.notes })], { type: 'text/html' })); add('catalogue.csv', new Blob([CAT.csv(rows)], { type: 'text/csv' }));
  if (sheet) add('contact-sheet.jpg', sheet);
  job.current = 'Packing the zip…'; render();
  const zip = await makeZip(entries);
  job.results.push({ name: dir + '.zip', blob: zip, size: zip.size, note: `${rows.length} loops` });
  if (sheet) job.results.push({ name: 'contact-sheet.jpg', blob: sheet, size: sheet.size, note: 'preview picture' });
}

async function runJob(job) {
  const c = job.c; job.status = 'running'; render();
  try {
    await ensureEngine();
    if (job.dir) job.taken = await stems(job.dir);
    const credits = [];
    for (let i = 0; i < job.items.length; i++) {
      job.ctl.check(); const it = job.items[i]; job.current = it.label; render();
      try {
        let file = it.file, srcName = it.name, folder = it.folder || '';
        if (it.result) { job.current = 'Downloading ' + it.label; render(); file = await SR.download(it.result, p => { job.progress = (job.finished + p * .5) / job.total; job.dirty = true; }, job.abort.signal); srcName = file.name; }
        if (job.tool === 'catalog' || job.tool === 'pack') { const row = await inspectOne(job, file, i, srcName, folder, c); job.rows.push(row); job.log.push(`OK  ${it.label}  ${row.info.width}x${row.info.height}, ${Math.round(row.info.duration * 10) / 10} s${row.loop ? ', ' + row.loop.verdict : ''}`); job.finished++; job.progress = job.finished / job.total; render(); continue; }
        const r = await processOne(job, file, i, srcName, folder, c, it.filter, it.v);
        if (r.skip) { job.log.push(`--  ${it.label}  ${r.skip}`); job.finished++; job.progress = job.finished / job.total; render(); continue; }
        if (job.dir) { const fh = await job.dir.getFileHandle(r.name, { create: true }), w = await fh.createWritable(); await w.write(r.blob); await w.close(); r.saved = true; r.blob = null; }
        job.results.push(r);
        if (it.result) credits.push([r.name, it.result.title, it.result.author, it.result.license, it.result.licenseUrl, it.result.page, new Date().toISOString().slice(0, 10)]);
        job.log.push(`OK  ${it.label}  ${r.note}`);
      } catch (e) {
        if (e instanceof Cancelled || job.ctl.cancel) throw new Cancelled();
        job.failed++; job.log.push(`ERR ${it.label}  ${String(e.message).slice(0, 250)}`);
      }
      job.finished++; job.progress = job.finished / job.total; render();
    }
    if (job.rows && job.rows.length) { job.current = 'Building the files…'; render(); await buildInspectOutputs(job); }
    if (credits.length) {
      const blob = new Blob([SR.creditsCsv(credits)], { type: 'text/csv' });
      if (job.dir) { const fh = await job.dir.getFileHandle('credits.csv', { create: true }), w = await fh.createWritable(); await w.write(blob); await w.close(); }
      else job.results.push({ name: 'credits.csv', blob, size: blob.size, note: 'who made the clips and under which licence' });
    }
    job.status = job.failed && job.failed === job.items.length ? 'failed' : 'done';
  } catch (e) {
    job.status = (e instanceof Cancelled || job.ctl.cancel) ? 'cancelled' : 'failed';
    if (job.status === 'failed') job.error = e.message;
  }
  job.progress = job.status === 'done' ? 1 : job.progress; job.current = ''; render();
  if (job.ctl.cancel) engine.terminate();
}

let running = false;
async function pump() {
  if (running) return; running = true;
  try { for (;;) { const j = JOBS.find(x => x.status === 'queued'); if (!j) break; await runJob(j); } } finally { running = false; }
}

async function start(kind, items) {
  $('#msg').textContent = '';
  if (!items.length) { $('#msg').textContent = kind === 'search' ? 'Select search results first.' : kind === 'fetch' ? 'Paste at least one link.' : 'Add and select some files first.'; return; }
  if (kind === 'pro') {
    try { if (engine.pick) await engine.pick(); } catch (e) { /* the engine decides below */ }
    if (engine.kind !== 'native') { $('#msg').textContent = 'HAP and ProRes need the Linux (local) version of Spektronautilus, because the web version cannot make them. Everything else on this page works in the browser.'; return; }
  }
  if (kind === 'ai') {
    try { if (engine.pick) await engine.pick(); } catch (e) { /* the engine decides below */ }
    if (engine.kind !== 'native') { $('#msg').textContent = 'AI upscaling needs the Linux (local) version of Spektronautilus. The web version cannot do it. Everything else on this page works in the browser.'; return; }
    if (!(engine.info && engine.info.v2x && engine.info.v2x.ok)) { $('#msg').textContent = 'AI upscaling needs Video2X. Read the note above the settings.'; return; }
  }
  const c = collect(); c.filterAmount = +$('#famt').value; let dir = null;
  if (c.ex.saveDirect && HAS_DIR) { try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { return; } }
  const job = { id: nextId++, tool: kind, status: 'queued', created: Date.now(), items, total: items.length, finished: 0, failed: 0, progress: 0, c, dir, taken: new Set(), results: [], rows: [], log: [], ctl: new Ctl(), abort: new AbortController(), current: '', open: false, urls: [] };
  JOBS.unshift(job); render(); pump();
}
$('#go').onclick = () => {
  if (tool === 'search') return start('search', [...RSEL].map(i => ({ result: { ...RES[i] }, label: RES[i].title, name: RES[i].id })));
  if (tool === 'filters') {
    if (!FSEL.size) { $('#msg').textContent = 'Pick at least one look first.'; return; }
    const out = []; for (const f of FILES.filters.filter(f => SEL.filters.has(f.id))) for (const fl of FILTERS.filter(x => FSEL.has(x.id))) out.push({ file: f.file, name: f.name, folder: f.folder, label: `${f.name} · ${fl.name}`, filter: fl.id });
    return start('filters', out);
  }
  if (tool === 'sizes') {
    if (!SSEL.size) { $('#msg').textContent = 'Pick at least one size first.'; return; }
    const out = []; for (const f of FILES.sizes.filter(f => SEL.sizes.has(f.id))) for (const z of SIZE_STEPS.filter(z => SSEL.has(z[0]))) out.push({ file: f.file, name: f.name, folder: f.folder, label: `${f.name} · ${z[0]}p`, v: { id: z[0], w: z[1], h: z[2] } });
    return start('sizes', out);
  }
  start(tool, FILES[tool].filter(f => SEL[tool].has(f.id)).map(f => ({ file: f.file, name: f.name, folder: f.folder, label: f.name })));
};
$('#fetchgo').onclick = () => {
  const urls = $('#urls').value.split(/\s+/).filter(Boolean);
  start('search', urls.map(u => ({ result: { provider: 'url', id: u.split('/').pop().split('?')[0] || 'clip', url: u, title: u, author: '', license: 'unknown - check the source', licenseUrl: '', page: u }, label: u, name: u })));
};

const NAMES = { convert: 'Convert', gif2mp4: 'GIF → MP4', loop: 'Make loops', filters: 'Filters', search: 'Find loops', crop: 'Crop & trim', sizes: 'Sizes', pro: 'HAP / ProRes', ai: 'AI upscale', catalog: 'Catalogue', pack: 'Loop pack' };
let rT;
function render() { clearTimeout(rT); rT = setTimeout(draw, 60); }
function cancelJob(j) {
  if (!j || !['queued', 'running'].includes(j.status)) return;
  j.ctl.cancel = true; j.abort.abort();
  if (j.status === 'queued') { j.status = 'cancelled'; render(); } else { engineStatus('Stopping…'); engine.terminate(); engineStatus(''); }
}
// the shared queue: every job is reported so the Queue page can show it, and stop requests from there come back here
const TOOL_LABEL = { ...NAMES, fetch: 'Find loops' };
function qsync(j, force) {
  const now = Date.now(), act = j.status === 'queued' || j.status === 'running';
  if (!force && j.qT && now - j.qT < 700 && j.qS === j.status) return;
  j.qT = now; const was = j.qS; j.qS = j.status;
  const names = j.items.map(i => i.label).slice(0, 2).join(', ') + (j.items.length > 2 ? ` +${j.items.length - 2}` : '');
  const key = Q.report({ id: j.id, app: 'tools', appLabel: TOOL_LABEL[j.tool] || 'Tools', url: location.pathname, title: names || 'Job', status: j.status, progress: j.progress, done: j.finished, total: j.total, failed: j.failed, current: j.current, error: j.error, created: j.created, canCancel: act, results: j.results.map(r => ({ name: r.name, size: r.size })) });
  if (!act && was !== j.status && !j.dir) { const fs = j.results.filter(r => r.blob).map(r => ({ name: r.name, blob: r.blob })); if (fs.length) Q.saveResults(key, fs); }
}
Q.onCancel((app, id) => { if (app === 'tools') cancelJob(JOBS.find(x => String(x.id) === id)); });
setInterval(() => JOBS.forEach(j => { if (j.status === 'queued' || j.status === 'running') qsync(j, true); }), 5000);
function draw() {
  JOBS.forEach(j => qsync(j));
  if (!JOBS.length) { $('#jobs').innerHTML = '<p class="muted">No jobs yet.</p>'; return; }
  $('#jobs').innerHTML = JOBS.map(j => {
    const run = j.status === 'running' || j.status === 'queued', fl = j.results.filter(r => r.name !== 'credits.csv' || !j.dir);
    return `<div class="card job" data-id="${j.id}"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b>${NAMES[j.tool]}</b><span class="chip ${j.status}">${j.status}</span><span class="muted">${new Date(j.created).toLocaleTimeString()}</span><span class="muted">${j.finished}/${j.total}</span>${j.failed ? `<span class="warn">${j.failed} failed</span>` : ''}</div>
 ${run ? `<div class="bar"><i style="width:${Math.round(j.progress * 100)}%"></i></div><div class="cur">${esc(j.current)}${j.status === 'queued' ? 'Waiting in line…' : ''}</div>` : ''}
 ${j.error ? `<div class="warn">${esc(j.error)}</div>` : ''}
 ${j.dir ? `<div class="muted" style="font-size:.85rem">Saved into the folder you chose.</div>` : ''}
 <div class="res">${fl.slice(0, 8).map(r => r.blob ? `<a href="${blobUrl(r)}" download="${esc(r.name)}">${esc(r.name)} <small class="muted">${fmtSize(r.size)}</small></a>` : `<a style="pointer-events:none">${esc(r.name)} <small class="muted">${fmtSize(r.size)} · saved</small></a>`).join('')}${fl.length > 8 ? `<span class="muted">… and ${fl.length - 8} more</span>` : ''}</div>
 ${j.open && fl[0] && fl[0].blob ? `<video controls loop muted autoplay src="${blobUrl(fl[0])}"></video>` : ''}
 ${j.log.length ? `<details><summary>Log (${j.log.length})</summary><pre>${esc(j.log.slice(-60).join('\n'))}</pre></details>` : ''}
 <div class="acts">${run ? `<button class="sm" data-a="cancel">Stop</button>` : `${fl.some(r => r.blob) ? `<button class="sm" data-a="prev">${j.open ? 'Hide preview' : 'Preview first'}</button><button class="sm" data-a="zip">Download all (zip)</button>${HAS_DIR ? '<button class="sm" data-a="save">Save all to a folder</button>' : ''}` : ''}<button class="sm" data-a="del">Remove from list</button>`}</div></div>`;
  }).join('');
}
const urls = new WeakMap();
function blobUrl(r) { if (!urls.has(r)) urls.set(r, URL.createObjectURL(r.blob)); return urls.get(r); }
setInterval(() => { if (JOBS.some(j => j.dirty)) { JOBS.forEach(j => j.dirty = false); draw(); } }, 400);
$('#jobs').onclick = async e => {
  const b = e.target.closest('[data-a]'); if (!b) return; const j = JOBS.find(x => x.id === +b.closest('.job').dataset.id), a = b.dataset.a;
  if (a === 'cancel') cancelJob(j);
  if (a === 'del') { j.results.forEach(r => urls.has(r) && URL.revokeObjectURL(urls.get(r))); JOBS.splice(JOBS.indexOf(j), 1); }
  if (a === 'prev') j.open = !j.open;
  if (a === 'zip') { try { const z = await makeZip(j.results.filter(r => r.blob).map(r => ({ name: r.name, blob: r.blob }))), u = URL.createObjectURL(z), l = document.createElement('a'); l.href = u; l.download = `vjtools-${j.id}.zip`; l.click(); setTimeout(() => URL.revokeObjectURL(u), 60000); } catch (er) { $('#msg').textContent = er.message; } }
  if (a === 'save') { try { const d = await window.showDirectoryPicker({ mode: 'readwrite' }); for (const r of j.results.filter(x => x.blob)) { const fh = await d.getFileHandle(r.name, { create: true }), w = await fh.createWritable(); await w.write(r.blob); await w.close(); } $('#msg').textContent = 'Saved.'; } catch (er) { if (er.name !== 'AbortError') $('#msg').textContent = er.message; } }
  draw();
};

// ---------------------------------------------------------------------------------------------- start
function init() {
  $('#tabs').innerHTML = Object.entries(TOOLS).map(([k, v]) => `<button data-t="${k}">${v.label}</button>`).join('');
  $('#tabs').onclick = e => { const b = e.target.closest('[data-t]'); b && setTool(b.dataset.t); };
  SR.status().filter(s => s.ready).forEach(s => SRCSEL.add(s.name)); renderSrcs();
  buildSettings(); renderSizes(); setTool(tool); draw();
  window.VJ = { JOBS, FILES, SEL, addFiles, start };   // handy for tests and for poking around in the console
}
init();
