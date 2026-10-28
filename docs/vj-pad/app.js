import { clamp, autoFadePos, posterFrame, POSTER_COLORS, parseTitle, parseMidi, midiKey, routeMidi, PADS, PAD_CODES, PAD_LABELS, LAYER_CODES, FX_CODES, BLENDS, FX, tapBpm, beatPos, pulse, KickDetector, bpmFromKicks, VJ_MIDI_ACTIONS } from './core.js';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('spk_vj_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spk_vj_' + k, JSON.stringify(v)); } catch {} },
};
const cfg = Object.assign({ res: '1280x720', fps: 30, fit: 'cover', fadeSec: 4, remember: false, bsrc: 'clock', sens: 50, every: 1, fxAmt: 60 }, store.get('cfg', {}));
const LAYERS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'];
const S = {
  f: 0, auto: null, pads: Array(PADS).fill(null), sel: 0,
  layers: LAYERS.map((n, i) => ({ id: n, ch: i < 3 ? 'A' : 'B', pad: -1, op: 1, blend: 'source-over', on: true })),
  bpm: store.get('bpm', 120), t0: performance.now(), taps: [], fx: Array(FX.length).fill(false), fxCfg: store.get('fxOn', null),
  kick: { t: -1e9, count: 0, times: [], det: new KickDetector(), trigT: -1e9 },
  poster: Object.assign({ l1: '', l2: '', color: 'neon', from: 'left', pos: 'bl', hold: 8, bg: '#ff2d7a', fg: '#ffffff' }, store.get('poster', {})),
  shown: null, slots: store.get('slots', Array(8).fill(null)), slot: 0,
  logo: { img: null, on: true, size: 10, op: 100 },
  midi: { access: null, map: store.get('midi', {}), learn: null },
  stream: null, out: null, lastTick: performance.now(), log: [], mic: null, tickN: 0,
};
if (S.fxCfg) S.fx = S.fxCfg.slice(0, FX.length); S.fxCfg = null;
window.SPK = { S, cfg };
const toastEl = $('#toast'); let toastT;
window.SPK_CHECK_EXTRA = () => { const n = S.pads.filter(Boolean).length; return [S.out && !S.out.closed ? { name: 'Output window', state: 'ok', msg: 'The output window is open.' } : { name: 'Output window', state: 'warn', msg: 'The output window is not open yet. Press “Open output window”.' },
  n ? { name: 'Loops', state: 'ok', msg: '{a} loop(s) loaded.', a: n } : { name: 'Loops', state: 'warn', msg: 'No loops yet. Add some to the pads first.' }]; };
function toast(msg, ms = 3500) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms); S.log.push(msg); }
const safe = (fn, label) => (...a) => { try { return fn(...a); } catch (e) { console.error(label, e); S.log.push('ERR ' + label + ': ' + e.message); } };

// ------------------------------------------------------------------ canvases
const prog = $('#prog'), cvA = $('#cvA'), cvB = $('#cvB'), comp = document.createElement('canvas');
const g = prog.getContext('2d', { alpha: false }), gA = cvA.getContext('2d', { alpha: false }), gB = cvB.getContext('2d', { alpha: false }), gc = comp.getContext('2d', { alpha: false });
function setRes() { const [w, h] = cfg.res.split('x').map(Number); for (const c of [prog, cvA, cvB, comp]) { c.width = w; c.height = h; } }
const filterOK = 'filter' in CanvasRenderingContext2D.prototype;

// ------------------------------------------------------------------ pads (each pad owns a paused, preloaded video: triggering is instant)
function makePad(i, file, silent) {
  if (S.pads[i]) freePad(i, true);
  const t = parseTitle(file.name), v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
  const p = { i, file, name: t.title || file.name, v, thumb: document.createElement('canvas'), ready: false, users: 0 };
  p.thumb.width = 160; p.thumb.height = 90;
  v.addEventListener('loadeddata', () => { p.ready = true; try { drawThumb(p); } catch {} renderPads(); });
  v.addEventListener('error', () => { toast(`Pad ${i + 1}: can't play “${file.name}”. Convert it to mp4 (H.264) with the Tools.`, 7000); freePad(i); });
  S.pads[i] = p; renderPads(); if (!silent) saveSession();
  return p;
}
function drawThumb(p) { const c = p.thumb.getContext('2d'), v = p.v, k = Math.max(160 / v.videoWidth, 90 / v.videoHeight); c.fillStyle = '#000'; c.fillRect(0, 0, 160, 90); c.drawImage(v, (160 - v.videoWidth * k) / 2, (90 - v.videoHeight * k) / 2, v.videoWidth * k, v.videoHeight * k); }
function freePad(i, replacing) {
  const p = S.pads[i]; if (!p) return;
  for (const L of S.layers) if (L.pad === i) L.pad = -1;
  p.v.pause(); p.v.removeAttribute('src'); p.v.load(); URL.revokeObjectURL(p.v.src); S.pads[i] = null;
  renderPads(); renderLayers(); if (!replacing) saveSession();
}
function addFiles(files, startAt = 0) {
  let n = 0, i = 0;
  for (const f of files) {
    if (!(f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name))) continue;
    while (i < PADS && S.pads[i]) i++;
    if (i >= PADS) { toast('All 20 pads are full. Remove one with ✕ first.'); break; }
    makePad(i, f); n++; i++;
  }
  if (n) toast(`${n} loop${n > 1 ? 's' : ''} added.`, 1800);
  return n;
}
function renderPads() {
  const box = $('#pads'); if (!box) return; box.innerHTML = '';
  for (let i = 0; i < PADS; i++) {
    const p = S.pads[i], b = document.createElement('div'); b.className = 'pad' + (p ? ' has' : '') + (S.layers.some(L => L.pad === i) ? ' live' : ''); b.tabIndex = 0; b.dataset.i = i; b.setAttribute('role', 'button');
    b.setAttribute('aria-label', p ? `Pad ${i + 1}: ${p.name}` : `Empty pad ${i + 1}. Add a loop.`);
    b.innerHTML = `<span class="k">${PAD_LABELS[i]}</span>` + (p ? '<span class="pn"></span><button class="x" aria-label="Remove loop">✕</button>' : '<span class="plus">+</span>');
    if (p) { b.insertBefore(p.thumb, b.firstChild); b.querySelector('.pn').textContent = p.name; }
    box.appendChild(b);
  }
}
$('#pads').onclick = e => {
  const b = e.target.closest('.pad'); if (!b) return; const i = +b.dataset.i;
  if (e.target.classList.contains('x')) { freePad(i); return; }
  if (!S.pads[i]) { S.addTo = i; $('#padFile').click(); return; }
  trigger(i);
};
$('#pads').onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('pad')) { e.preventDefault(); e.stopPropagation(); e.target.click(); } };
$('#padFile').onchange = e => { if (e.target.files[0] && S.addTo != null) makePad(S.addTo, e.target.files[0]); e.target.value = ''; };
$('#addBtn').onclick = () => $('#files').click();
$('#files').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); const pad = e.target.closest && e.target.closest('.pad'); const files = [...(e.dataTransfer?.files || [])];
  if (pad && !S.pads[+pad.dataset.i] && files[0]) { makePad(+pad.dataset.i, files[0]); addFiles(files.slice(1)); } else addFiles(files); });

// trigger a pad on the selected layer
function trigger(i) {
  const p = S.pads[i]; if (!p) { toast(`Pad ${i + 1} is empty.`); return; }
  const L = S.layers[S.sel]; L.pad = i; L.on = true;
  try { p.v.currentTime = 0; } catch {}
  p.v.play().catch(() => {});
  pruneVideos(); renderLayers(); renderPads();
}
function pruneVideos() {                       // pause pad videos that no layer uses, play the ones that are used
  S.pads.forEach((p, i) => { if (!p) return; const used = S.layers.some(L => L.pad === i && L.on); if (used && p.v.paused) p.v.play().catch(() => {}); else if (!used && !p.v.paused) p.v.pause(); });
}
function clearLayer(n) { const L = S.layers[n]; L.pad = -1; pruneVideos(); renderLayers(); renderPads(); }

// ------------------------------------------------------------------ layers UI
function renderLayers() {
  const box = $('#chans'); box.innerHTML = '';
  for (const ch of ['A', 'B']) {
    const c = document.createElement('div'); c.className = 'card'; c.innerHTML = `<h2>Channel ${ch}</h2>`;
    S.layers.forEach((L, n) => {
      if (L.ch !== ch) return;
      const p = L.pad >= 0 ? S.pads[L.pad] : null, r = document.createElement('div'); r.className = 'lay' + (S.sel === n ? ' sel' : ''); r.dataset.n = n;
      r.innerHTML = `<button class="lb" data-a="sel" title="Select this layer. Pads you press go here.">${L.id}</button><div class="th"></div><div class="nm">${p ? p.name.replace(/</g, '&lt;') : '<span class="hint">empty — pick a pad</span>'}</div>
        <div><button class="sm ${L.on ? 'on' : ''}" data-a="on">${L.on ? 'On' : 'Off'}</button> <button class="sm" data-a="clr" aria-label="Clear layer">✕</button></div>
        <div class="row2"><label class="hint">Opacity</label><input type="range" min="0" max="100" value="${Math.round(L.op * 100)}" data-a="op" aria-label="Opacity ${L.id}"><select data-a="bl" aria-label="Blend ${L.id}">${BLENDS.map(([v, t]) => `<option value="${v}" ${L.blend === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
      if (p) r.querySelector('.th').appendChild(p.thumb);
      c.appendChild(r);
    });
    box.appendChild(c);
  }
}
$('#chans').addEventListener('click', e => {
  const r = e.target.closest('.lay'); if (!r) return; const n = +r.dataset.n, L = S.layers[n], a = e.target.dataset.a;
  if (a === 'sel') { S.sel = n; renderLayers(); } else if (a === 'on') { L.on = !L.on; pruneVideos(); renderLayers(); } else if (a === 'clr') clearLayer(n);
});
$('#chans').addEventListener('input', e => {
  const r = e.target.closest('.lay'); if (!r) return; const L = S.layers[+r.dataset.n];
  if (e.target.dataset.a === 'op') L.op = e.target.value / 100; else if (e.target.dataset.a === 'bl') L.blend = e.target.value;
});
function selectLayer(n) { S.sel = clamp(n, 0, 5); renderLayers(); }

// ------------------------------------------------------------------ crossfader
const xf = $('#xf');
function setF(f, fromUser) { S.f = clamp(f); if (fromUser) S.auto = null; xf.value = Math.round(S.f * 1000); $('#monA').classList.toggle('air', S.f < 0.5); $('#monB').classList.toggle('air', S.f >= 0.5); $('#mix').textContent = S.auto ? 'Mixing…' : (S.f < 0.5 ? 'Mix → B' : 'Mix → A'); }
xf.oninput = () => { S.auto = null; setF(xf.value / 1000); };
function mix() {
  if (S.auto) return false;
  const to = S.f < 0.5 ? 1 : 0; S.auto = { from: S.f, to, t0: performance.now(), dur: clamp(+cfg.fadeSec || 4, 0.5, 60) * 1000 };
  $('#mix').textContent = 'Mixing…'; return true;
}
$('#mix').onclick = mix;

// ------------------------------------------------------------------ beat
const period = () => 60000 / S.bpm;
function setBpm(b, keepPhase) { S.bpm = clamp(Math.round(b * 10) / 10, 40, 220); $('#bpm').value = S.bpm; store.set('bpm', S.bpm); }
function tap() {
  const now = performance.now(); S.taps.push(now); if (S.taps.length > 12) S.taps.shift();
  const b = tapBpm(S.taps); if (b) setBpm(b);
  S.t0 = now;                                  // the tap itself is the beat
}
$('#tap').onclick = tap;
$('#bpm').onchange = () => setBpm(+$('#bpm').value || 120);
$('#half').onclick = () => setBpm(S.bpm / 2); $('#dbl').onclick = () => setBpm(S.bpm * 2);
$('#beat1').onclick = () => { S.t0 = performance.now(); };
function buildFx() {
  const box = $('#fx'); box.innerHTML = '';
  FX.forEach((f, i) => { const b = document.createElement('button'); b.dataset.i = i; b.className = S.fx[i] ? 'on' : ''; b.innerHTML = `${f.name}<small>${['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K'][i]}</small>`; b.onclick = () => toggleFx(i); box.appendChild(b); });
}
function toggleFx(i) { S.fx[i] = !S.fx[i]; store.set('fxOn', S.fx); buildFx(); }
// effect strength 0..1 for the current moment
function fxPhase(now) {
  const every = +cfg.every || 1;
  if (cfg.bsrc === 'audio') { const P = Math.max(250, period()); return (now - S.kick.trigT) / P; }
  return beatPos(now, S.t0, period(), every);
}
async function setBeatSource(src) {
  cfg.bsrc = src; store.set('cfg', cfg); $('#sensL').style.display = src === 'audio' ? '' : 'none';
  if (src === 'audio') {
    if (S.mic) return;
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)(), an = ctx.createAnalyser(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 150; an.fftSize = 1024; ctx.createMediaStreamSource(st).connect(lp); lp.connect(an);
      S.mic = { st, ctx, an, buf: new Uint8Array(an.fftSize) }; $('#bnote').textContent = 'Listening… the beat follows the kick drum.';
    } catch (e) { $('#bnote').textContent = 'Could not use the audio input: ' + e.message; cfg.bsrc = 'clock'; $('#bsrc').value = 'clock'; $('#sensL').style.display = 'none'; }
  } else if (S.mic) { S.mic.st.getTracks().forEach(t => t.stop()); S.mic.ctx.close().catch(() => {}); S.mic = null; $('#bnote').textContent = ''; }
}
function listenKick(now) {
  const m = S.mic; if (!m) return;
  m.an.getByteTimeDomainData(m.buf); let s = 0; for (const x of m.buf) { const d = (x - 128) / 128; s += d * d; } const e = Math.sqrt(s / m.buf.length);
  S.kick.det.s = cfg.sens / 100;
  if (S.kick.det.feed(e, now)) {
    S.kick.t = now; S.kick.count++; S.kick.times.push(now); if (S.kick.times.length > 16) S.kick.times.shift();
    if (S.kick.count % (+cfg.every || 1) === 0) S.kick.trigT = now;
    const b = bpmFromKicks(S.kick.times); if (b && S.kick.count % 4 === 0) setBpm(b);
  }
}

// ------------------------------------------------------------------ drawing
function drawLayer(c, el, W, H, L) {
  const k = (cfg.fit === 'cover' ? Math.max : Math.min)(W / el.videoWidth, H / el.videoHeight), w = el.videoWidth * k, h = el.videoHeight * k;
  c.globalAlpha = L.op; c.globalCompositeOperation = L.blend; c.drawImage(el, (W - w) / 2, (H - h) / 2, w, h);
}
function drawChannel(c, ch) {
  const W = prog.width, H = prog.height; c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  for (const L of S.layers) {
    if (L.ch !== ch || !L.on || L.pad < 0 || L.op <= 0) continue;
    const p = S.pads[L.pad]; if (!p || !p.ready || p.v.readyState < 2 || !p.v.videoWidth) continue;
    drawLayer(c, p.v, W, H, L);
  }
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
}
function applyFx(now) {
  const W = prog.width, H = prog.height, amt = cfg.fxAmt / 100, ph = fxPhase(now), env = pulse(ph) * amt, on = i => S.fx[i];
  g.save(); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  let filt = ''; if (filterOK) { if (on(6)) filt += `hue-rotate(${Math.round(pulse(ph) * 360 * amt)}deg) saturate(${1 + pulse(ph) * amt})`; if (on(7)) filt += ` blur(${(pulse(ph) * amt * H * 0.012).toFixed(1)}px)`; if (filt) g.filter = filt.trim(); }
  let sc = on(0) ? 1 + 0.14 * env : 1, dx = 0, dy = 0;
  if (on(1)) { const m = W * 0.015 * env; dx = (Math.random() * 2 - 1) * m; dy = (Math.random() * 2 - 1) * m; }
  g.translate(W / 2 + dx, H / 2 + dy); g.scale(sc, sc); g.translate(-W / 2, -H / 2);
  g.drawImage(comp, 0, 0);
  if (on(5)) { g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(comp, 0, 0, W / 2, H, 0, 0, W / 2, H); g.restore(); }
  g.restore(); g.filter = 'none';
  if (on(2) && env > 0.01) { g.globalAlpha = Math.min(1, env * 0.9); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  if (on(3)) { const f = (ph * 2) % 1; if (f > 0.5) { g.globalAlpha = Math.min(1, amt * 1.3); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; } }
  if (on(4) && pulse(ph) * amt > 0.35) { g.globalCompositeOperation = 'difference'; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over'; }
}
function rr(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function drawPoster(now) {
  const s = S.shown; if (!s) return;
  const fr = posterFrame(now - s.t0, 700, s.hold, 600); if (fr.phase === 'off') { S.shown = null; return; }
  const W = prog.width, H = prog.height, m = H * 0.05, pad = H * 0.022, f1 = H * 0.062, f2 = H * 0.036, ft = 'system-ui,"Segoe UI",Roboto,sans-serif';
  g.save(); g.textBaseline = 'alphabetic';
  g.font = `800 ${f1}px ${ft}`; const w1 = s.l1 ? g.measureText(s.l1).width : 0; g.font = `600 ${f2}px ${ft}`; const w2 = s.l2 ? g.measureText(s.l2).width : 0;
  const bar = H * 0.012, bw = Math.min(W - 2 * m, Math.max(w1, w2) + pad * 2 + bar), bh = pad * 2 + (s.l1 ? f1 * 1.05 : 0) + (s.l2 ? f2 * 1.25 : 0);
  const x = s.pos === 'br' ? W - m - bw : s.pos === 'bc' ? (W - bw) / 2 : m, y = s.pos === 'tl' ? m : H - m - bh; let ox = 0, oy = 0; const q = 1 - fr.p;
  if (s.from === 'left') ox = -(x + bw + 10) * q; else if (s.from === 'right') ox = (W - x + 10) * q; else oy = (s.pos === 'tl' ? -(y + bh + 10) : (H - y + 10)) * q;
  g.translate(ox, oy); g.shadowColor = '#0006'; g.shadowBlur = H * 0.02; g.shadowOffsetY = H * 0.006;
  g.fillStyle = s.c.bg; rr(x, y, bw, bh, H * 0.012); g.fill(); g.shadowColor = 'transparent'; g.fillStyle = s.c.accent; rr(x, y, bar, bh, H * 0.006); g.fill();
  g.fillStyle = s.c.fg; let ty = y + pad;
  if (s.l1) { g.font = `800 ${f1}px ${ft}`; ty += f1 * 0.85; g.fillText(s.l1, x + pad + bar, ty, bw - 2 * pad - bar); ty += f1 * 0.2; }
  if (s.l2) { g.font = `600 ${f2}px ${ft}`; ty += f2 * 0.95; g.globalAlpha = 0.92; g.fillText(s.l2, x + pad + bar, ty, bw - 2 * pad - bar); }
  g.restore();
}
function drawLogo() { const L = S.logo; if (!L.img || !L.on) return; const W = prog.width, H = prog.height, m = H * 0.04; let h = H * L.size / 100, w = h * L.img.width / L.img.height; if (w > W * 0.3) { w = W * 0.3; h = w * L.img.height / L.img.width; } g.globalAlpha = L.op / 100; g.drawImage(L.img, W - m - w, m, w, h); g.globalAlpha = 1; }

let dotsT = 0, uiT = 0;
function tick() {
  const now = performance.now(); S.lastTick = now; S.tickN++;
  try {
    if (S.auto) { const a = S.auto, p = autoFadePos(a.from, a.to, now - a.t0, a.dur); setF(p); if (now - a.t0 >= a.dur) { S.auto = null; setF(a.to); } }
    // a channel that is not heard or seen right now is only redrawn every 3rd frame (just for its small preview): saves a lot of work on weaker computers
    if (S.f < 0.999 || S.tickN % 3 === 0) drawChannel(gA, 'A'); if (S.f > 0.001 || S.tickN % 3 === 0) drawChannel(gB, 'B');
    gc.globalAlpha = 1; gc.fillStyle = '#000'; gc.fillRect(0, 0, comp.width, comp.height);
    if (S.f < 0.999) gc.drawImage(cvA, 0, 0);
    if (S.f > 0.001) { gc.globalAlpha = S.f >= 0.999 ? 1 : S.f; gc.drawImage(cvB, 0, 0); gc.globalAlpha = 1; }
    applyFx(now); drawPoster(now); drawLogo();
  } catch (e) { S.log.push('draw: ' + e.message); }
  safe(listenKick, 'kick')(now);
  if (now - dotsT > 60) { dotsT = now; safe(updateDots, 'dots')(now); }
  if (now - uiT > 400) { uiT = now; if (S.out && S.out.closed) S.out = null; $('#outstate').textContent = S.out ? 'Output window open' : ''; if (S.out) { try { S.out.setStream && S.out.setStream(S.stream); } catch {} } }
}
function updateDots(now) {
  const dots = $('#dots').children, P = period();
  const b = cfg.bsrc === 'audio' ? S.kick.count : Math.floor((now - S.t0) / P), within = cfg.bsrc === 'audio' ? now - S.kick.t < 120 : ((now - S.t0) % P) / P < 0.25;
  const idx = ((b % 4) + 4) % 4; for (let i = 0; i < 4; i++) dots[i].classList.toggle('on', within && i === idx);
}
let worker = null, fallback = null;
function startTicker() {
  stopTicker(); const ms = Math.round(1000 / (+cfg.fps || 30));
  try { worker = new Worker(URL.createObjectURL(new Blob([`let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`], { type: 'text/javascript' }))); worker.onmessage = tick; worker.postMessage(ms); }
  catch { fallback = setInterval(tick, ms); }
}
function stopTicker() { if (worker) { worker.postMessage(0); worker.terminate(); worker = null; } if (fallback) { clearInterval(fallback); fallback = null; } }
setInterval(() => { if (performance.now() - S.lastTick > 2500) { S.log.push('ticker restarted'); startTicker(); } }, 2000);

// ------------------------------------------------------------------ posters, logo
function showPoster(over = {}) {
  const p = Object.assign({}, S.poster, over); if (!p.l1 && !p.l2) { toast('Type some text for the poster first.'); return; }
  const c = p.color === 'custom' ? { bg: p.bg, fg: p.fg, accent: p.fg } : (POSTER_COLORS.find(x => x.id === p.color) || POSTER_COLORS[0]);
  S.shown = { l1: p.l1, l2: p.l2, c, from: p.from, pos: p.pos, t0: performance.now(), hold: p.hold > 0 ? p.hold * 1000 : Infinity };
}
function hidePoster() { const s = S.shown; if (!s) return; const el = performance.now() - s.t0; s.hold = Math.max(0, Math.min(s.hold, el - 700)); }
function posterForm() { S.poster.l1 = $('#pl1').value; S.poster.l2 = $('#pl2').value; S.poster.from = $('#pfrom').value; S.poster.pos = $('#ppos').value; S.poster.hold = clamp(+$('#phold').value || 0, 0, 600); S.poster.bg = $('#cbg').value; S.poster.fg = $('#cfg').value; store.set('poster', S.poster); }
function buildColors() { const box = $('#colors'); box.innerHTML = ''; for (const c of [...POSTER_COLORS, { id: 'custom', name: 'Custom', bg: 'linear-gradient(135deg,#f00,#0f0,#00f)', fg: '#fff' }]) { const b = document.createElement('button'); b.style.background = c.bg; b.style.color = c.fg; b.title = c.name; b.setAttribute('aria-label', c.name); b.dataset.id = c.id; b.textContent = c.id === 'custom' ? '+' : 'Aa'; b.onclick = () => { S.poster.color = c.id; store.set('poster', S.poster); markColors(); }; box.appendChild(b); } markColors(); }
const markColors = () => document.querySelectorAll('#colors button').forEach(b => b.classList.toggle('sel', b.dataset.id === S.poster.color));
function renderSlots() { const box = $('#slots'); box.innerHTML = ''; S.slots.forEach((s, i) => { const b = document.createElement('button'); b.className = i === S.slot ? 'sel' : ''; b.textContent = s ? (s.l1 || s.l2) : `Slot ${i + 1}`; b.onclick = () => { S.slot = i; if (s) { Object.assign(S.poster, s); fillPosterForm(); showPoster(); } renderSlots(); }; box.appendChild(b); }); }
function slotShow(n) { const s = S.slots[n - 1]; if (s) { Object.assign(S.poster, s); fillPosterForm(); showPoster(); } else toast(`Poster slot ${n} is empty.`); }
function fillPosterForm() { $('#pl1').value = S.poster.l1; $('#pl2').value = S.poster.l2; $('#pfrom').value = S.poster.from; $('#ppos').value = S.poster.pos; $('#phold').value = S.poster.hold; $('#cbg').value = S.poster.bg; $('#cfg').value = S.poster.fg; markColors(); }
for (const id of ['pl1', 'pl2', 'pfrom', 'ppos', 'phold', 'cbg', 'cfg']) $('#' + id).addEventListener('input', posterForm);
$('#pshow').onclick = () => { posterForm(); showPoster(); }; $('#phide').onclick = hidePoster;
$('#psave').onclick = () => { posterForm(); const { l1, l2, color, from, pos, hold, bg, fg } = S.poster; S.slots[S.slot] = { l1, l2, color, from, pos, hold, bg, fg }; store.set('slots', S.slots); renderSlots(); toast(`Saved to slot ${S.slot + 1}.`, 1500); };
function loadLogoFile(file) {
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => { const k = Math.min(1, 600 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); const data = c.toDataURL('image/png'); store.set('logo', data); const i2 = new Image(); i2.onload = () => { S.logo.img = i2; }; i2.src = data; };
  img.onerror = () => toast('That file is not an image the browser can read.'); img.src = url;
}
$('#logoFile').onchange = e => { if (e.target.files[0]) loadLogoFile(e.target.files[0]); };
$('#logoClear').onclick = () => { S.logo.img = null; store.set('logo', null); };
const logoSet = () => { S.logo.on = $('#logoOn').checked; S.logo.size = +$('#logoSize').value; S.logo.op = +$('#logoOp').value; store.set('logoCfg', { on: S.logo.on, size: S.logo.size, op: S.logo.op }); };
for (const id of ['logoOn', 'logoSize', 'logoOp']) $('#' + id).addEventListener('input', logoSet);

// ------------------------------------------------------------------ output window
async function openOutput() {
  let feat = 'popup,width=960,height=540';
  try { if (window.getScreenDetails) { const sd = await window.getScreenDetails(); const x = sd.screens.find(s => !s.isPrimary); if (x) feat = `popup,left=${x.availLeft},top=${x.availTop},width=${x.availWidth},height=${x.availHeight}`; } } catch {}
  const w = window.open('output.html', 'spk_output', feat);
  if (!w) { toast('The browser blocked the pop-up. Allow pop-ups for this site and try again.', 6000); return; }
  S.out = w; const t0 = Date.now(); const iv = setInterval(() => { try { if (w.setStream) { w.setStream(S.stream); clearInterval(iv); } } catch {} if (Date.now() - t0 > 5000) clearInterval(iv); }, 150);
  toast('Output window open. Drag it to the projector and press F.', 5000);
}
$('#openOut').onclick = openOutput;

// ------------------------------------------------------------------ session memory (IndexedDB)
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('spk_vj', 1); r.onupgradeneeded = () => r.result.createObjectStore('pads'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function saveSession() {
  if (!cfg.remember) return;
  try { const db = await idb(), tx = db.transaction('pads', 'readwrite'), st = tx.objectStore('pads'); st.clear(); S.pads.forEach((p, i) => { if (p) st.put({ name: p.file.name, type: p.file.type, blob: p.file }, i); }); await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); }); }
  catch (e) { toast('Could not remember the loops: ' + e.message); }
}
async function restoreSession() {
  if (!cfg.remember) return;
  try { const db = await idb(), st = db.transaction('pads').objectStore('pads'), keys = await new Promise(r => { const q = st.getAllKeys(); q.onsuccess = () => r(q.result); }), vals = await new Promise(r => { const q = st.getAll(); q.onsuccess = () => r(q.result); });
    keys.forEach((k, j) => { const v = vals[j]; if (v && v.blob) makePad(k, new File([v.blob], v.name, { type: v.type }), true); }); if (keys.length) toast(`${keys.length} loops restored.`, 2000); }
  catch {}
}
async function clearSession() { try { const db = await idb(); db.transaction('pads', 'readwrite').objectStore('pads').clear(); } catch {} }

// ------------------------------------------------------------------ MIDI
function midiAction({ action: a, value: v }) {
  if (a === 'xfade') setF(v, true); else if (a === 'mix') mix(); else if (a === 'tap') tap(); else if (a === 'beat1') S.t0 = performance.now();
  else if (a === 'fxAmount') { cfg.fxAmt = Math.round(v * 100); $('#fxAmt').value = cfg.fxAmt; store.set('cfg', cfg); }
  else if (a.startsWith('fx')) toggleFx(+a.slice(2) - 1); else if (a.startsWith('pad')) trigger(+a.slice(3) - 1);
  else if (a.startsWith('sel')) selectLayer(+a.slice(3) - 1); else if (a.startsWith('op')) { S.layers[+a.slice(2) - 1].op = v; renderLayers(); }
  else if (a.startsWith('poster') && a !== 'posterHide') slotShow(+a.slice(6)); else if (a === 'posterHide') hidePoster();
  else if (a === 'logo') { $('#logoOn').checked = !$('#logoOn').checked; logoSet(); }
}
function onMidi(data) {
  const m = parseMidi(data); if (!m) return; if (m.type !== 'noteoff') $('#midiLast').textContent = `${m.type} ch${m.ch + 1} #${m.num} = ${Math.round(m.val * 127)}`;
  if (S.midi.learn) { if (m.type === 'noteoff') return; const key = midiKey(m), id = S.midi.learn; for (const k of Object.keys(S.midi.map)) if (S.midi.map[k] === id || k === key) delete S.midi.map[k]; S.midi.map[key] = id; S.midi.learn = null; store.set('midi', S.midi.map); renderMidi(); return; }
  const r = routeMidi(m, S.midi.map, VJ_MIDI_ACTIONS); if (r) safe(midiAction, 'midi')(r);
}
function renderMidi() {
  const t = $('#mtbl'); t.innerHTML = '';
  for (const a of VJ_MIDI_ACTIONS) { const key = Object.keys(S.midi.map).find(k => S.midi.map[k] === a.id), tr = document.createElement('tr');
    tr.innerHTML = `<td>${a.label}</td><td class="k">${key ? key.replace(/^(\w+):(\d+):(\d+)$/, (_, ty, c, n) => `${ty} ch${+c + 1} #${n}`) : '—'}</td><td><button class="sm ${S.midi.learn === a.id ? 'on' : ''}" data-l="${a.id}">${S.midi.learn === a.id ? 'Move a control…' : 'Learn'}</button> ${key ? `<button class="sm" data-c="${a.id}">Clear</button>` : ''}</td>`; t.appendChild(tr); }
}
$('#mtbl').onclick = e => { if (e.target.dataset.l) { S.midi.learn = S.midi.learn === e.target.dataset.l ? null : e.target.dataset.l; renderMidi(); } if (e.target.dataset.c) { for (const k of Object.keys(S.midi.map)) if (S.midi.map[k] === e.target.dataset.c) delete S.midi.map[k]; store.set('midi', S.midi.map); renderMidi(); } };
async function enableMidi() {
  if (!navigator.requestMIDIAccess) { $('#midiStatus').textContent = 'This browser has no MIDI support. Use Chrome or Edge on a computer.'; return; }
  try { const acc = await navigator.requestMIDIAccess({ sysex: false }); S.midi.access = acc;
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
  if (e.target.classList && e.target.classList.contains('pad') && (e.key === 'Enter' || e.key === ' ')) return;
  const c = e.code, isRange = tag === 'INPUT' && t.type === 'range'; let i;
  if ((i = PAD_CODES.indexOf(c)) >= 0 && !e.repeat) trigger(i);
  else if ((i = LAYER_CODES.indexOf(c)) >= 0) selectLayer(i);
  else if ((i = FX_CODES.indexOf(c)) >= 0 && !e.repeat) toggleFx(i);
  else if (c === 'Space') { e.preventDefault(); mix(); }
  else if (c === 'ArrowLeft' && !isRange) { e.preventDefault(); setF(S.f - 0.05, true); } else if (c === 'ArrowRight' && !isRange) { e.preventDefault(); setF(S.f + 0.05, true); }
  else if ((c === 'Backquote' || c === 'Period') && !e.repeat) tap();
  else if (c === 'Enter') { posterForm(); showPoster(); } else if (c === 'Escape') hidePoster();
  else if (c === 'KeyL') { $('#logoOn').checked = !$('#logoOn').checked; logoSet(); }
  else if (c === 'Tab' && !e.shiftKey && tag === 'BODY') { e.preventDefault(); selectLayer((S.sel + 1) % 6); }
  else if (c === 'Backspace' && tag === 'BODY') { e.preventDefault(); clearLayer(S.sel); }
});
addEventListener('beforeunload', e => { if (S.pads.some(Boolean) && !cfg.remember) { e.preventDefault(); e.returnValue = ''; } });
let wl = null; const keepAwake = async () => { try { if (navigator.wakeLock && document.visibilityState === 'visible') wl = await navigator.wakeLock.request('screen'); } catch {} };
document.addEventListener('visibilitychange', keepAwake);
$('#theme').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; store.set('theme', t); };

function initSettings() {
  const map = { res: 'value', fps: 'value', fit: 'value', fadeSec: 'value', remember: 'checked', every: 'value', fxAmt: 'value', sens: 'value', bsrc: 'value' };
  for (const [id, prop] of Object.entries(map)) {
    const el = $('#' + (id === 'every' ? 'every' : id)); if (!el) continue; el[prop] = cfg[id];
    el.addEventListener('input', () => {
      cfg[id] = prop === 'checked' ? el.checked : (['fps', 'fadeSec', 'every', 'fxAmt', 'sens'].includes(id) ? +el.value : el.value); store.set('cfg', cfg);
      if (id === 'res') setRes(); if (id === 'fps') startTicker(); if (id === 'bsrc') setBeatSource(cfg.bsrc);
      if (id === 'remember') { if (cfg.remember) saveSession(); else clearSession(); }
    });
  }
}
async function init() {
  document.documentElement.dataset.theme = store.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  initSettings(); setRes(); buildColors(); renderSlots(); fillPosterForm(); renderMidi(); buildFx(); renderPads(); renderLayers(); $('#bpm').value = S.bpm;
  const lc = store.get('logoCfg', null); if (lc) { Object.assign(S.logo, lc); $('#logoOn').checked = lc.on; $('#logoSize').value = lc.size; $('#logoOp').value = lc.op; }
  const ld = store.get('logo', null); if (ld) { const i = new Image(); i.onload = () => { S.logo.img = i; }; i.src = ld; }
  S.stream = prog.captureStream(); setF(0); startTicker(); keepAwake();
  if (cfg.bsrc === 'audio') { cfg.bsrc = 'clock'; $('#bsrc').value = 'clock'; }       // the microphone needs a click first
  if (store.get('midiOn', false) && navigator.requestMIDIAccess) enableMidi();
  await restoreSession();
}
init();
Object.assign(window.SPK, { trigger, mix, setF, tap, toggleFx, selectLayer, showPoster, hidePoster, addFiles, tick, onMidi, openOutput, slotShow, setBeatSource, setBpm, makePad, freePad, clearLayer });
