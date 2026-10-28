import { clamp, audioGains, onAir, autoFadePos, posterFrame, POSTER_COLORS, parseTitle, fmtTime, parseMidi, midiKey, routeMidi, MIDI_ACTIONS } from './core.js';

const $ = s => document.querySelector(s);
const PRELOAD_MAX = 1.5e9;
const store = {
  get(k, d) { try { const v = localStorage.getItem('spk_live_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spk_live_' + k, JSON.stringify(v)); } catch {} },
};

// ------------------------------------------------------------------ state
const cfg = Object.assign({ res: '1920x1080', fps: 30, fit: 'contain', curve: 'power', preload: true, limiter: true, audioFollow: true, autoMix: false, fadeSec: 8, autoSec: 12, autoPoster: false, sink: '' }, store.get('cfg', {}));
const S = {
  f: 0, auto: null, lib: [], nextId: 1, stream: null, out: null, rec: null,
  decks: { A: null, B: null },
  poster: Object.assign({ l1: '', l2: '', color: 'neon', from: 'left', pos: 'bl', hold: 8, bg: '#ff2d7a', fg: '#ffffff' }, store.get('poster', {})),
  shown: null, slots: store.get('slots', Array(8).fill(null)), slot: 0,
  logo: { img: null, on: true, size: 10, op: 100 },
  midi: { access: null, map: store.get('midi', {}), learn: null },
  lastTick: performance.now(), audio: null, autoLoading: false, log: [],
};
window.SPK = { S, cfg };

const toastEl = $('#toast'); let toastT;
window.SPK_CHECK_EXTRA = () => [S.out && !S.out.closed ? { name: 'Output window', state: 'ok', msg: 'The output window is open.' } : { name: 'Output window', state: 'warn', msg: 'The output window is not open yet. Press “Open output window”.' },
  S.lib.length ? { name: 'Tracks', state: 'ok', msg: '{a} track(s) in the list.', a: S.lib.length } : { name: 'Tracks', state: 'warn', msg: 'No tracks yet. Add some videos first.' }];
function toast(msg, ms = 3500) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms); S.log.push(msg); }
const safe = (fn, label) => (...a) => { try { return fn(...a); } catch (e) { console.error(label || fn.name, e); S.log.push('ERR ' + (label || fn.name) + ': ' + e.message); } };

// ------------------------------------------------------------------ audio graph
function ensureAudio() {
  if (S.audio) { if (S.audio.ctx.state === 'suspended') S.audio.ctx.resume().catch(() => {}); return S.audio; }
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  const ctx = new AC({ latencyHint: 'playback' });
  const master = ctx.createGain(), lim = ctx.createDynamicsCompressor(), an = ctx.createAnalyser(), rec = ctx.createMediaStreamDestination();
  lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.15;
  an.fftSize = 512;
  master.connect(lim); lim.connect(ctx.destination); lim.connect(rec); lim.connect(an);
  S.audio = { ctx, master, lim, an, rec, bypass: false };
  for (const id of ['A', 'B']) {
    const d = S.decks[id]; d.src = ctx.createMediaElementSource(d.el); d.gain = ctx.createGain(); d.an = ctx.createAnalyser(); d.an.fftSize = 512;
    d.src.connect(d.gain); d.gain.connect(master); d.gain.connect(d.an);
  }
  applyLimiter(); applyGains(true); listSinks();
  return S.audio;
}
function applyLimiter() { const a = S.audio; if (!a) return; try { a.lim.threshold.value = cfg.limiter ? -3 : 0; a.lim.ratio.value = cfg.limiter ? 20 : 1; } catch {} }
function applyGains(now) {
  const a = S.audio; if (!a) return;
  const g = cfg.audioFollow ? audioGains(S.f, cfg.curve) : { a: 1, b: 1 };
  for (const [id, k] of [['A', g.a], ['B', g.b]]) {
    const d = S.decks[id], v = d.vol * k;
    if (now) d.gain.gain.value = v; else d.gain.gain.setTargetAtTime(v, a.ctx.currentTime, 0.015);
  }
}
const peak = an => { const b = new Uint8Array(an.fftSize); an.getByteTimeDomainData(b); let m = 0; for (const x of b) m = Math.max(m, Math.abs(x - 128)); return m / 128; };

async function listSinks() {
  const sel = $('#sink'), note = $('#sinkNote');
  if (!S.audio || !S.audio.ctx.setSinkId) { note.textContent = 'Choosing the sound device needs a recent Chrome or Edge. The system default is used.'; sel.disabled = true; return; }
  try { const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'); sel.innerHTML = '<option value="">Default</option>' + devs.filter(d => d.deviceId && d.deviceId !== 'default').map(d => `<option value="${d.deviceId}">${d.label || 'Output ' + d.deviceId.slice(0, 5)}</option>`).join(''); sel.value = cfg.sink || ''; }
  catch {}
}

// ------------------------------------------------------------------ decks
function makeDeck(id) {
  const el = $('#v' + id); el.volume = 1;
  const d = { id, el, vol: 1, item: null, url: null, token: 0, src: null, gain: null, an: null };
  S.decks[id] = d;
  const box = document.createElement('div');
  box.className = 'card deck'; box.dataset.deck = id;
  box.innerHTML = `<h2>Deck ${id} <span class="chip" id="st${id}">empty</span></h2><div class="nm" id="nm${id}">Nothing loaded</div>
    <input type="range" class="seek" id="sk${id}" min="0" max="1000" value="0" aria-label="Position deck ${id}" disabled>
    <div class="tm"><span id="cu${id}">0:00</span><span id="du${id}">0:00</span></div>
    <div class="drow"><button class="main" id="pl${id}" disabled>Play</button><button id="rs${id}" disabled>Restart</button><button id="ej${id}" class="sm" disabled>Eject</button>
      <label class="hint" style="display:flex;gap:6px;align-items:center;flex:1">Volume <input type="range" id="vo${id}" min="0" max="100" value="100" aria-label="Volume deck ${id}"></label></div>
    <div class="drow"><span class="hint">Level</span><div class="meter"><i id="me${id}"></i></div></div>`;
  $('#decks').appendChild(box);
  $('#pl' + id).onclick = () => togglePlay(id);
  $('#rs' + id).onclick = () => { if (d.item) { el.currentTime = 0; } };
  $('#ej' + id).onclick = () => eject(id);
  $('#vo' + id).oninput = e => { d.vol = e.target.value / 100; applyGains(); };
  const sk = $('#sk' + id);
  sk.oninput = () => { if (isFinite(el.duration)) el.currentTime = el.duration * sk.value / 1000; };
  el.addEventListener('error', () => {
    if (!d.item) return;
    toast(`Deck ${id} can't play “${d.item.name}”. The format may not be supported here. Convert it to mp4 (H.264) with the Tools.`, 7000);
    eject(id, true);
  });
  el.addEventListener('play', () => { if (d.item) { d.item.played = true; renderLib(); } updateDeckUI(id); });
  el.addEventListener('pause', () => updateDeckUI(id));
  el.addEventListener('ended', () => updateDeckUI(id));
  el.addEventListener('loadedmetadata', () => updateDeckUI(id));
}

async function load(id, item) {
  const d = S.decks[id]; const tok = ++d.token;
  ensureAudio();
  if (S.out && S.out.closed) S.out = null;
  d.el.pause();
  const st = $('#st' + id); st.textContent = 'loading…'; st.className = 'chip cue';
  $('#nm' + id).textContent = item.name;
  let blob = item.file;
  try {
    if (cfg.preload && item.file.size < PRELOAD_MAX) { blob = new Blob([await item.file.arrayBuffer()], { type: item.file.type || 'video/mp4' }); }
  } catch (e) { toast('Not enough memory to preload this file. It will be streamed from disk.'); blob = item.file; }
  if (tok !== d.token) return false;                 // a newer load replaced this one
  if (d.url) URL.revokeObjectURL(d.url);
  d.url = URL.createObjectURL(blob); d.item = item;
  d.el.src = d.url; d.el.load();
  const ok = await new Promise(res => {
    const done = v => { d.el.removeEventListener('loadedmetadata', a); d.el.removeEventListener('error', b); clearTimeout(t); res(v); };
    const a = () => done(true), b = () => done(false), t = setTimeout(() => done(false), 20000);
    if (d.el.readyState >= 1) done(true); else { d.el.addEventListener('loadedmetadata', a); d.el.addEventListener('error', b); }
  });
  if (tok !== d.token) return false;
  if (!ok) { eject(id, true); return false; }
  d.el.currentTime = 0;
  updateDeckUI(id); renderLib();
  return true;
}
function eject(id, quiet) {
  const d = S.decks[id]; d.token++;
  d.el.pause(); d.el.removeAttribute('src'); d.el.load();
  if (d.url) URL.revokeObjectURL(d.url);
  d.url = null; d.item = null;
  updateDeckUI(id); renderLib();
}
function togglePlay(id) {
  const d = S.decks[id]; if (!d.item) { toast(`Load a track on deck ${id} first.`); return; }
  ensureAudio();
  if (d.el.paused) { d.el.play().catch(e => toast(`Deck ${id} could not start: ${e.message}`)); } else d.el.pause();
}
function updateDeckUI(id) {
  const d = S.decks[id], has = !!d.item, el = d.el;
  $('#nm' + id).textContent = has ? d.item.name : 'Nothing loaded';
  for (const k of ['pl', 'rs', 'ej']) $('#' + k + id).disabled = !has;
  $('#sk' + id).disabled = !has;
  $('#pl' + id).textContent = has && !el.paused ? 'Pause' : 'Play';
  const st = $('#st' + id);
  const live = has && !el.paused && (onAir(S.f) === id || (S.f > 0.02 && S.f < 0.98));
  st.textContent = !has ? 'empty' : live ? 'on air' : el.paused ? (el.ended ? 'ended' : 'cued') : 'playing';
  st.className = 'chip' + (live ? ' live' : has ? ' cue' : '');
  $('#du' + id).textContent = fmtTime(el.duration);
}

// ------------------------------------------------------------------ crossfader and fades
const xf = $('#xf');
function setF(f, fromUser) {
  S.f = clamp(f); if (fromUser) S.auto = null;
  xf.value = Math.round(S.f * 1000); applyGains();
  $('#monA').classList.toggle('air', S.f < 0.5); $('#monB').classList.toggle('air', S.f >= 0.5);
  $('#mix').textContent = S.auto ? 'Mixing…' : (S.f < 0.5 ? 'Mix → B' : 'Mix → A');
}
xf.oninput = () => { S.auto = null; setF(xf.value / 1000); };
function mix(opts = {}) {
  if (S.auto) return false;
  const to = S.f < 0.5 ? 1 : 0, inc = to === 1 ? 'B' : 'A', d = S.decks[inc];
  if (!d.item) { toast(`Load a track on deck ${inc} first.`); return false; }
  ensureAudio();
  if (d.el.paused) d.el.play().catch(e => toast(`Deck ${inc} could not start: ${e.message}`));
  const out = S.decks[to === 1 ? 'A' : 'B'];
  let dur = clamp(+cfg.fadeSec || 8, 1, 60) * 1000;
  if (opts.maxMs) dur = Math.min(dur, Math.max(1000, opts.maxMs));
  S.auto = { from: S.f, to, t0: performance.now(), dur, out: out.id };
  if (cfg.autoPoster && d.item) { const t = parseTitle(d.item.name); showPoster({ l1: t.artist || t.title, l2: t.artist ? t.title : '' }); }
  $('#mix').textContent = 'Mixing…';
  return true;
}
function finishFade() {
  const a = S.auto; S.auto = null; setF(a.to);
  const out = S.decks[a.out];
  if (out.item) { out.el.pause(); out.item.played = true; }
  $('#mix').textContent = S.f < 0.5 ? 'Mix → B' : 'Mix → A';
  updateDeckUI('A'); updateDeckUI('B'); renderLib();
  if (cfg.autoMix) { nextUnplayed(out) && load(out.id, nextUnplayed(out)); }
}
$('#mix').onclick = () => mix();
const nextUnplayed = () => S.lib.find(i => !i.played && S.decks.A.item !== i && S.decks.B.item !== i);

function autoWatch() {                              // runs a few times a second
  if (!cfg.autoMix || S.auto || S.autoLoading) return;
  const air = S.decks[onAir(S.f)], other = S.decks[onAir(S.f) === 'A' ? 'B' : 'A'];
  const el = air.el; if (!air.item || el.paused || !isFinite(el.duration)) return;
  const rem = el.duration - el.currentTime, lead = clamp(+cfg.fadeSec || 8, 1, 60) + 1;
  const trig = Math.max(lead, +cfg.autoSec || 12);
  if (rem > trig) return;
  if (other.item) { mix({ maxMs: (rem - 0.3) * 1000 }); return; }
  const n = nextUnplayed(); if (!n) return;
  S.autoLoading = true;
  load(other.id, n).then(ok => { S.autoLoading = false; if (ok) mix({ maxMs: Math.max(1000, (air.el.duration - air.el.currentTime - 0.3) * 1000) }); }).catch(() => { S.autoLoading = false; });
}

// ------------------------------------------------------------------ library
function addFiles(files) {
  let n = 0;
  for (const f of files) {
    if (!(f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name))) continue;
    const t = parseTitle(f.name);
    S.lib.push({ id: S.nextId++, file: f, name: t.artist ? `${t.artist} – ${t.title}` : t.title, size: f.size, played: false }); n++;
  }
  renderLib(); if (n) toast(`${n} track${n > 1 ? 's' : ''} added.`, 1800);
  return n;
}
function renderLib() {
  const box = $('#lib'); if (!box) return;
  if (!S.lib.length) { box.innerHTML = '<span class="hint">No tracks yet.</span>'; return; }
  box.innerHTML = '';
  S.lib.forEach((it, i) => {
    const r = document.createElement('div'); r.className = 'li' + (it.played ? ' played' : '');
    const on = ['A', 'B'].filter(k => S.decks[k] && S.decks[k].item === it).join('');
    r.innerHTML = `<span class="t" title="${it.name.replace(/"/g, '&quot;')}">${on ? `<span class="chip live">${on}</span> ` : ''}${it.name.replace(/</g, '&lt;')}</span><small>${(it.size / 1e6).toFixed(0)} MB</small>
      <button class="sm" data-a="A">→ A</button><button class="sm" data-a="B">→ B</button><button class="sm" data-a="up" aria-label="Move up">↑</button><button class="sm" data-a="dn" aria-label="Move down">↓</button><button class="sm" data-a="rm" aria-label="Remove">✕</button>`;
    r.onclick = e => {
      const a = e.target.dataset && e.target.dataset.a; if (!a) return;
      if (a === 'A' || a === 'B') load(a, it);
      else if (a === 'rm') { for (const k of ['A', 'B']) if (S.decks[k].item === it) eject(k); S.lib.splice(i, 1); renderLib(); }
      else if (a === 'up' && i > 0) { [S.lib[i - 1], S.lib[i]] = [S.lib[i], S.lib[i - 1]]; renderLib(); }
      else if (a === 'dn' && i < S.lib.length - 1) { [S.lib[i + 1], S.lib[i]] = [S.lib[i], S.lib[i + 1]]; renderLib(); }
    };
    box.appendChild(r);
  });
}
$('#addBtn').onclick = () => $('#files').click();
$('#files').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
addEventListener('dragover', e => { e.preventDefault(); const dk = e.target.closest && e.target.closest('.deck'); document.querySelectorAll('.deck').forEach(x => x.classList.toggle('over', x === dk)); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.querySelectorAll('.deck').forEach(x => x.classList.remove('over')); });
addEventListener('drop', e => {
  e.preventDefault(); document.querySelectorAll('.deck').forEach(x => x.classList.remove('over'));
  const dk = e.target.closest && e.target.closest('.deck'); const files = [...(e.dataTransfer?.files || [])];
  const before = S.lib.length; addFiles(files);
  if (dk && S.lib.length > before) load(dk.dataset.deck, S.lib[before]);
});

// ------------------------------------------------------------------ posters and logo
function showPoster(over = {}) {
  const p = Object.assign({}, S.poster, over);
  if (!p.l1 && !p.l2) { toast('Type some text for the poster first.'); return; }
  const c = p.color === 'custom' ? { bg: p.bg, fg: p.fg, accent: p.fg } : (POSTER_COLORS.find(x => x.id === p.color) || POSTER_COLORS[0]);
  S.shown = { l1: p.l1, l2: p.l2, c, from: p.from, pos: p.pos, t0: performance.now(), hold: p.hold > 0 ? p.hold * 1000 : Infinity };
}
function hidePoster() {
  const s = S.shown; if (!s) return;
  const el = performance.now() - s.t0; s.hold = Math.max(0, Math.min(s.hold, el - 700));
}
function posterForm() {
  S.poster.l1 = $('#pl1').value; S.poster.l2 = $('#pl2').value; S.poster.from = $('#pfrom').value; S.poster.pos = $('#ppos').value;
  S.poster.hold = clamp(+$('#phold').value || 0, 0, 600); S.poster.bg = $('#cbg').value; S.poster.fg = $('#cfg').value; store.set('poster', S.poster);
}
function buildColors() {
  const box = $('#colors'); box.innerHTML = '';
  for (const c of [...POSTER_COLORS, { id: 'custom', name: 'Custom', bg: 'linear-gradient(135deg,#f00,#0f0,#00f)', fg: '#fff' }]) {
    const b = document.createElement('button'); b.style.background = c.bg; b.style.color = c.fg; b.title = c.name; b.setAttribute('aria-label', c.name); b.dataset.id = c.id; b.textContent = c.id === 'custom' ? '+' : 'Aa';
    b.onclick = () => { S.poster.color = c.id; store.set('poster', S.poster); markColors(); };
    box.appendChild(b);
  }
  markColors();
}
const markColors = () => document.querySelectorAll('#colors button').forEach(b => b.classList.toggle('sel', b.dataset.id === S.poster.color));
function renderSlots() {
  const box = $('#slots'); box.innerHTML = '';
  S.slots.forEach((s, i) => {
    const b = document.createElement('button'); b.className = i === S.slot ? 'sel' : '';
    b.textContent = s ? (s.l1 || s.l2) : `Slot ${i + 1}`; b.title = s ? `${s.l1} / ${s.l2}` : 'Empty. Fill in a poster and press Save.';
    b.onclick = () => { S.slot = i; if (s) { Object.assign(S.poster, s); fillPosterForm(); showPoster(); } renderSlots(); };
    box.appendChild(b);
  });
}
function slotShow(n) { const s = S.slots[n - 1]; if (s) { Object.assign(S.poster, s); fillPosterForm(); showPoster(); } else toast(`Poster slot ${n} is empty.`); }
function fillPosterForm() {
  $('#pl1').value = S.poster.l1; $('#pl2').value = S.poster.l2; $('#pfrom').value = S.poster.from; $('#ppos').value = S.poster.pos;
  $('#phold').value = S.poster.hold; $('#cbg').value = S.poster.bg; $('#cfg').value = S.poster.fg; markColors();
}
for (const id of ['pl1', 'pl2', 'pfrom', 'ppos', 'phold', 'cbg', 'cfg']) $('#' + id).addEventListener('input', posterForm);
$('#pshow').onclick = () => { posterForm(); showPoster(); };
$('#phide').onclick = hidePoster;
$('#psave').onclick = () => { posterForm(); const { l1, l2, color, from, pos, hold, bg, fg } = S.poster; S.slots[S.slot] = { l1, l2, color, from, pos, hold, bg, fg }; store.set('slots', S.slots); renderSlots(); toast(`Saved to slot ${S.slot + 1}.`, 1500); };

function setLogo(img) { S.logo.img = img; }
function loadLogoFile(file) {
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    const k = Math.min(1, 600 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
    const data = c.toDataURL('image/png'); store.set('logo', data); const i2 = new Image(); i2.onload = () => setLogo(i2); i2.src = data;
  };
  img.onerror = () => toast('That file is not an image the browser can read.'); img.src = url;
}
$('#logoFile').onchange = e => { if (e.target.files[0]) loadLogoFile(e.target.files[0]); };
$('#logoClear').onclick = () => { setLogo(null); store.set('logo', null); };
const logoSet = () => { S.logo.on = $('#logoOn').checked; S.logo.size = +$('#logoSize').value; S.logo.op = +$('#logoOp').value; store.set('logoCfg', { on: S.logo.on, size: S.logo.size, op: S.logo.op }); };
for (const id of ['logoOn', 'logoSize', 'logoOp']) $('#' + id).addEventListener('input', logoSet);

// ------------------------------------------------------------------ program canvas
const prog = $('#prog'), g = prog.getContext('2d', { alpha: false });
function setRes() { const [w, h] = cfg.res.split('x').map(Number); prog.width = w; prog.height = h; }
function drawDeck(d, alpha) {
  const el = d.el; if (!d.item || el.readyState < 2 || !el.videoWidth) return;
  const W = prog.width, H = prog.height, k = (cfg.fit === 'cover' ? Math.max : Math.min)(W / el.videoWidth, H / el.videoHeight);
  const w = el.videoWidth * k, h = el.videoHeight * k;
  g.globalAlpha = alpha; g.drawImage(el, (W - w) / 2, (H - h) / 2, w, h); g.globalAlpha = 1;
}
function rr(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function drawPoster(now) {
  const s = S.shown; if (!s) return;
  const fr = posterFrame(now - s.t0, 700, s.hold, 600); if (fr.phase === 'off') { S.shown = null; return; }
  const W = prog.width, H = prog.height, m = H * 0.05, pad = H * 0.022, f1 = H * 0.062, f2 = H * 0.036, ft = 'system-ui,"Segoe UI",Roboto,sans-serif';
  g.save(); g.textBaseline = 'alphabetic';
  g.font = `800 ${f1}px ${ft}`; const w1 = s.l1 ? g.measureText(s.l1).width : 0;
  g.font = `600 ${f2}px ${ft}`; const w2 = s.l2 ? g.measureText(s.l2).width : 0;
  const bar = H * 0.012, bw = Math.min(W - 2 * m, Math.max(w1, w2) + pad * 2 + bar), bh = pad * 2 + (s.l1 ? f1 * 1.05 : 0) + (s.l2 ? f2 * 1.25 : 0);
  let x = s.pos === 'br' ? W - m - bw : s.pos === 'bc' ? (W - bw) / 2 : m;
  let y = s.pos === 'tl' ? m : H - m - bh, ox = 0, oy = 0; const q = 1 - fr.p;
  if (s.from === 'left') ox = -(x + bw + 10) * q; else if (s.from === 'right') ox = (W - x + 10) * q; else oy = (s.pos === 'tl' ? -(y + bh + 10) : (H - y + 10)) * q;
  g.translate(ox, oy); g.shadowColor = '#0006'; g.shadowBlur = H * 0.02; g.shadowOffsetY = H * 0.006;
  g.fillStyle = s.c.bg; rr(x, y, bw, bh, H * 0.012); g.fill(); g.shadowColor = 'transparent';
  g.fillStyle = s.c.accent; rr(x, y, bar, bh, H * 0.006); g.fill();
  g.fillStyle = s.c.fg; let ty = y + pad;
  if (s.l1) { g.font = `800 ${f1}px ${ft}`; ty += f1 * 0.85; g.fillText(s.l1, x + pad + bar, ty, bw - 2 * pad - bar); ty += f1 * 0.2; }
  if (s.l2) { g.font = `600 ${f2}px ${ft}`; ty += f2 * 0.95; g.globalAlpha = 0.92; g.fillText(s.l2, x + pad + bar, ty, bw - 2 * pad - bar); }
  g.restore();
}
function drawLogo() {
  const L = S.logo; if (!L.img || !L.on) return;
  const W = prog.width, H = prog.height, m = H * 0.04; let h = H * L.size / 100, w = h * L.img.width / L.img.height;
  if (w > W * 0.3) { w = W * 0.3; h = w * L.img.height / L.img.width; }
  g.globalAlpha = L.op / 100; g.drawImage(L.img, W - m - w, m, w, h); g.globalAlpha = 1;
}
let meterT = 0, autoT = 0, uiT = 0;
function tick() {
  const now = performance.now(); S.lastTick = now;
  try {
    if (S.auto) { const a = S.auto, p = autoFadePos(a.from, a.to, now - a.t0, a.dur); setF(p); if (now - a.t0 >= a.dur) finishFade(); }
    g.fillStyle = '#000'; g.fillRect(0, 0, prog.width, prog.height);
    if (S.f < 0.999) drawDeck(S.decks.A, 1);
    if (S.f > 0.001) drawDeck(S.decks.B, S.f >= 0.999 ? 1 : S.f);
    drawPoster(now); drawLogo();
  } catch (e) { S.log.push('draw: ' + e.message); }
  if (now - meterT > 70) { meterT = now; safe(updateMeters, 'meters')(); }
  if (now - uiT > 250) { uiT = now; safe(updateTimes, 'times')(); }
  if (now - autoT > 400) { autoT = now; safe(autoWatch, 'autoWatch')(); }
}
function updateMeters() {
  const a = S.audio; if (!a) return;
  $('#meA').style.width = Math.min(100, peak(S.decks.A.an) * 140) + '%'; $('#meB').style.width = Math.min(100, peak(S.decks.B.an) * 140) + '%';
  const m = peak(a.an); $('#mMaster').style.width = Math.min(100, m * 140) + '%'; $('#mMaster').style.background = m > 0.95 ? 'var(--bad)' : 'var(--ok)';
}
function updateTimes() {
  for (const id of ['A', 'B']) {
    const d = S.decks[id], el = d.el; if (!d.item) continue;
    $('#cu' + id).textContent = fmtTime(el.currentTime); $('#du' + id).textContent = fmtTime(el.duration);
    if (document.activeElement !== $('#sk' + id) && isFinite(el.duration)) $('#sk' + id).value = Math.round(el.currentTime / el.duration * 1000);
    updateDeckUI(id);
  }
  const rem = cfg.autoMix ? '' : '';
  $('#autoNote').textContent = cfg.autoMix ? (S.lib.some(i => !i.played) || S.decks.A.item || S.decks.B.item ? 'Auto-mix on' : 'Auto-mix on (add tracks)') : '';
  // output window state
  if (S.out && S.out.closed) S.out = null;
  $('#outstate').textContent = S.out ? 'Output window open' : '';
  if (S.out) { try { S.out.setStream && S.out.setStream(S.stream); } catch {} }
}

// ticker that is not throttled when this window is in the background
let worker = null, fallback = null;
function startTicker() {
  stopTicker(); const ms = Math.round(1000 / (+cfg.fps || 30));
  try {
    worker = new Worker(URL.createObjectURL(new Blob([`let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`], { type: 'text/javascript' })));
    worker.onmessage = tick; worker.postMessage(ms);
  } catch { fallback = setInterval(tick, ms); }
}
function stopTicker() { if (worker) { worker.postMessage(0); worker.terminate(); worker = null; } if (fallback) { clearInterval(fallback); fallback = null; } }
setInterval(() => { if (performance.now() - S.lastTick > 2500) { S.log.push('ticker restarted'); startTicker(); } }, 2000);

// ------------------------------------------------------------------ output window, record
async function openOutput() {
  let feat = 'popup,width=960,height=540';
  try { if (window.getScreenDetails) { const sd = await window.getScreenDetails(); const x = sd.screens.find(s => !s.isPrimary); if (x) feat = `popup,left=${x.availLeft},top=${x.availTop},width=${x.availWidth},height=${x.availHeight}`; } } catch {}
  const w = window.open('output.html', 'spk_output', feat);
  if (!w) { toast('The browser blocked the pop-up. Allow pop-ups for this site and try again.', 6000); return; }
  S.out = w;
  const t0 = Date.now(); const iv = setInterval(() => { try { if (w.setStream) { w.setStream(S.stream); clearInterval(iv); } } catch {} if (Date.now() - t0 > 5000) clearInterval(iv); }, 150);
  toast('Output window open. Drag it to the projector and press F.', 5000);
}
$('#openOut').onclick = openOutput;
function startRec() {
  const a = ensureAudio(); const tracks = [...S.stream.getVideoTracks(), ...(a ? a.rec.stream.getAudioTracks() : [])];
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mt = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!mt) { toast('This browser can not record. Use OBS to capture the output window.'); return; }
  const chunks = [], mr = new MediaRecorder(new MediaStream(tracks), { mimeType: mt, videoBitsPerSecond: 8e6 });
  mr.ondataavailable = e => e.data.size && chunks.push(e.data);
  mr.onstop = () => { const b = new Blob(chunks, { type: 'video/webm' }), u = URL.createObjectURL(b), l = document.createElement('a'), d = new Date(); l.href = u; l.download = `spektronautilus-mix-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.webm`; l.click(); setTimeout(() => URL.revokeObjectURL(u), 60000); toast('Recording saved.'); };
  mr.start(1000); S.rec = mr; $('#rec').classList.add('on'); $('#rec').textContent = '■ Stop';
}
$('#rec').onclick = () => { if (S.rec) { S.rec.stop(); S.rec = null; $('#rec').classList.remove('on'); $('#rec').textContent = '● Record'; } else startRec(); };

// ------------------------------------------------------------------ MIDI
function midiAction(r) {
  const { action: a, value: v } = r;
  if (a === 'xfade') setF(v, true);
  else if (a === 'mix') mix();
  else if (a === 'playA') togglePlay('A'); else if (a === 'playB') togglePlay('B');
  else if (a === 'volA' || a === 'volB') { const id = a.slice(3); S.decks[id].vol = v; $('#vo' + id).value = Math.round(v * 100); applyGains(); }
  else if (a.startsWith('poster') && a !== 'posterHide') slotShow(+a.slice(6));
  else if (a === 'posterHide') hidePoster();
  else if (a === 'logo') { $('#logoOn').checked = !$('#logoOn').checked; logoSet(); }
}
function onMidi(data) {
  const m = parseMidi(data); if (!m) return;
  if (m.type !== 'noteoff') $('#midiLast').textContent = `${m.type} ch${m.ch + 1} #${m.num} = ${Math.round(m.val * 127)}`;
  if (S.midi.learn) {
    if (m.type === 'noteoff') return;
    const key = midiKey(m), id = S.midi.learn;
    for (const k of Object.keys(S.midi.map)) if (S.midi.map[k] === id || k === key) delete S.midi.map[k];
    S.midi.map[key] = id; S.midi.learn = null; store.set('midi', S.midi.map); renderMidi(); return;
  }
  const r = routeMidi(m, S.midi.map); if (r) safe(midiAction, 'midi')(r);
}
function renderMidi() {
  const t = $('#mtbl'); t.innerHTML = '';
  for (const a of MIDI_ACTIONS) {
    const key = Object.keys(S.midi.map).find(k => S.midi.map[k] === a.id), tr = document.createElement('tr');
    tr.innerHTML = `<td>${a.label}</td><td class="k">${key ? key.replace(/^(\w+):(\d+):(\d+)$/, (_, ty, c, n) => `${ty} ch${+c + 1} #${n}`) : '—'}</td><td><button class="sm ${S.midi.learn === a.id ? 'on' : ''}" data-l="${a.id}">${S.midi.learn === a.id ? 'Move a control…' : 'Learn'}</button> ${key ? `<button class="sm" data-c="${a.id}">Clear</button>` : ''}</td>`;
    t.appendChild(tr);
  }
}
$('#mtbl').onclick = e => {
  if (e.target.dataset.l) { S.midi.learn = S.midi.learn === e.target.dataset.l ? null : e.target.dataset.l; renderMidi(); }
  if (e.target.dataset.c) { for (const k of Object.keys(S.midi.map)) if (S.midi.map[k] === e.target.dataset.c) delete S.midi.map[k]; store.set('midi', S.midi.map); renderMidi(); }
};
async function enableMidi() {
  if (!navigator.requestMIDIAccess) { $('#midiStatus').textContent = 'This browser has no MIDI support. Use Chrome or Edge on a computer.'; return; }
  try {
    const acc = await navigator.requestMIDIAccess({ sysex: false }); S.midi.access = acc;
    const hook = () => { let n = 0; acc.inputs.forEach(i => { i.onmidimessage = e => onMidi(e.data); n++; }); $('#midiStatus').textContent = n ? `${n} device${n > 1 ? 's' : ''} connected: ` + [...acc.inputs.values()].map(i => i.name).join(', ') : 'On, but no device found. Plug one in.'; };
    acc.onstatechange = hook; hook(); $('#midiOn').classList.add('on'); store.set('midiOn', true);
  } catch (e) { $('#midiStatus').textContent = 'MIDI was not allowed: ' + e.message; }
}
$('#midiOn').onclick = enableMidi;

// ------------------------------------------------------------------ keys, settings, startup
addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target, tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type))) return;
  if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
  const k = e.key.toLowerCase(), isRange = tag === 'INPUT' && t.type === 'range';
  if (k === '1') togglePlay('A'); else if (k === '2') togglePlay('B');
  else if (k === ' ') { e.preventDefault(); mix(); }
  else if (e.key === 'ArrowLeft' && !isRange) { e.preventDefault(); setF(S.f - 0.05, true); }
  else if (e.key === 'ArrowRight' && !isRange) { e.preventDefault(); setF(S.f + 0.05, true); }
  else if (k === 'p') { posterForm(); showPoster(); } else if (k === 'h') hidePoster();
  else if (k === 'l') { $('#logoOn').checked = !$('#logoOn').checked; logoSet(); }
  else if (k === 'o') openOutput();
});
addEventListener('pointerdown', () => ensureAudio(), { once: false, passive: true });
addEventListener('beforeunload', e => { if (S.decks.A.item || S.decks.B.item || S.rec) { e.preventDefault(); e.returnValue = ''; } });
let wl = null; const keepAwake = async () => { try { if (navigator.wakeLock && document.visibilityState === 'visible') wl = await navigator.wakeLock.request('screen'); } catch {} };
document.addEventListener('visibilitychange', keepAwake);

const settingIds = { res: 'value', fps: 'value', fit: 'value', curve: 'value', sink: 'value', preload: 'checked', limiter: 'checked', audioFollow: 'checked', autoMix: 'checked', autoPoster: 'checked', fadeSec: 'value', autoSec: 'value' };
function initSettings() {
  for (const [id, prop] of Object.entries(settingIds)) {
    const el = $('#' + id); if (!el) continue; el[prop] = cfg[id];
    el.addEventListener('input', () => {
      cfg[id] = prop === 'checked' ? el.checked : (['fps', 'fadeSec', 'autoSec'].includes(id) ? +el.value : el.value); store.set('cfg', cfg);
      if (id === 'res') setRes(); if (id === 'fps') startTicker(); if (id === 'limiter') applyLimiter(); if (id === 'audioFollow' || id === 'curve') applyGains();
      if (id === 'sink' && S.audio && S.audio.ctx.setSinkId) S.audio.ctx.setSinkId(el.value || '').catch(e => toast('Could not switch the sound output: ' + e.message));
    });
  }
}
$('#theme').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; store.set('theme', t); };

function init() {
  document.documentElement.dataset.theme = store.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  makeDeck('A'); makeDeck('B'); initSettings(); setRes(); buildColors(); renderSlots(); fillPosterForm(); renderMidi(); renderLib();
  const lc = store.get('logoCfg', null); if (lc) { Object.assign(S.logo, lc); $('#logoOn').checked = lc.on; $('#logoSize').value = lc.size; $('#logoOp').value = lc.op; }
  const ld = store.get('logo', null); if (ld) { const i = new Image(); i.onload = () => setLogo(i); i.src = ld; }
  S.stream = prog.captureStream();
  setF(0); startTicker(); keepAwake();
  if (store.get('midiOn', false) && navigator.requestMIDIAccess) enableMidi();
}
init();
Object.assign(window.SPK, { load, mix, togglePlay, setF, showPoster, hidePoster, addFiles, tick, onMidi, openOutput, eject, slotShow });
