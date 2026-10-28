import { clamp, autoFadePos, posterFrame, POSTER_COLORS, parseTitle } from '../live-dj/core.js';
import { FX, tapBpm, beatPos, pulse } from '../vj-pad/core.js';
import { makeOffer, accept } from '../live-mobile/cast.js';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('spk_vjm_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spk_vjm_' + k, JSON.stringify(v)); } catch {} },
};
const PADS = 8;
const cfg = Object.assign({ res: '960x540', fps: 30, fit: 'cover', fadeSec: 4, fxAmt: 60 }, store.get('cfg', {}));
const S = {
  f: 0, auto: null, pads: Array(PADS).fill(null), sel: 0,
  layers: ['A1', 'A2', 'B1', 'B2'].map(n => ({ id: n, ch: n[0], pad: -1, op: 1, blend: 'source-over', on: true })),
  bpm: store.get('bpm', 120), t0: performance.now(), taps: [], fx: Array(FX.length).fill(false),
  poster: Object.assign({ l1: '', l2: '', color: 'neon' }, store.get('poster', {})), shown: null,
  logo: { img: null, on: true, size: 12 }, cast: null, stream: null, lastTick: performance.now(), log: [], addTo: null,
};
window.SPK = { S, cfg };
const toastEl = $('#toast'); let toastT;
window.SPK_CHECK_EXTRA = () => { const n = S.pads.filter(Boolean).length; return [n ? { name: 'Loops', state: 'ok', msg: '{a} loop(s) loaded.', a: n } : { name: 'Loops', state: 'warn', msg: 'No loops yet. Add some to the pads first.' }]; };
function toast(msg, ms = 3500) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms); S.log.push(msg); }

// ---------------------------------------------------------------- canvases
const prog = $('#prog'), g = prog.getContext('2d', { alpha: false }), comp = document.createElement('canvas'), gc = comp.getContext('2d', { alpha: false });
const cA = document.createElement('canvas'), cB = document.createElement('canvas'), gA = cA.getContext('2d', { alpha: false }), gB = cB.getContext('2d', { alpha: false });
function setRes() { const [w, h] = cfg.res.split('x').map(Number); for (const c of [prog, comp, cA, cB]) { c.width = w; c.height = h; } }
const filterOK = 'filter' in CanvasRenderingContext2D.prototype;

// ---------------------------------------------------------------- pads (each pad owns a paused, preloaded video, so a tap is instant)
function makePad(i, file) {
  if (S.pads[i]) freePad(i, true);
  const t = parseTitle(file.name), v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto'; v.src = URL.createObjectURL(file);
  const p = { i, file, name: t.title || file.name, v, thumb: document.createElement('canvas'), ready: false };
  p.thumb.width = 160; p.thumb.height = 100;
  v.addEventListener('loadeddata', () => { p.ready = true; try { const k = Math.max(160 / v.videoWidth, 100 / v.videoHeight), c = p.thumb.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, 160, 100); c.drawImage(v, (160 - v.videoWidth * k) / 2, (100 - v.videoHeight * k) / 2, v.videoWidth * k, v.videoHeight * k); } catch {} renderAll(); });
  v.addEventListener('error', () => { toast(`Pad ${i + 1}: can't play “${file.name}”. Try an mp4 (H.264) file.`, 6000); freePad(i); });
  S.pads[i] = p; renderAll(); return p;
}
function freePad(i, replacing) {
  const p = S.pads[i]; if (!p) return;
  for (const L of S.layers) if (L.pad === i) L.pad = -1;
  const u = p.v.src; p.v.pause(); p.v.removeAttribute('src'); p.v.load(); try { URL.revokeObjectURL(u); } catch {} S.pads[i] = null; if (!replacing) renderAll();
}
function addFiles(files) {
  let n = 0, i = 0;
  for (const f of files) {
    if (!(f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name))) continue;
    while (i < PADS && S.pads[i]) i++;
    if (i >= PADS) { toast('All 8 pads are full. Remove one with ✕ first.'); break; }
    makePad(i, f); n++; i++;
  }
  if (n) toast(`${n} loop${n > 1 ? 's' : ''} added.`, 1800); return n;
}
function renderPads() {
  const box = $('#pads'); box.innerHTML = '';
  for (let i = 0; i < PADS; i++) {
    const p = S.pads[i], b = document.createElement('button'); b.className = 'pad' + (p ? '' : ' empty') + (S.layers.some(L => L.pad === i && L.on) ? ' live' : ''); b.dataset.i = i;
    b.setAttribute('aria-label', p ? `Pad ${i + 1}: ${p.name}` : `Empty pad ${i + 1}. Add a loop.`);
    if (p) { b.appendChild(p.thumb); const n = document.createElement('span'); n.className = 'pn'; n.textContent = p.name; b.appendChild(n); const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.setAttribute('aria-label', 'Remove loop'); x.dataset.x = i; b.appendChild(x); }
    else b.innerHTML = '<span class="plus">+</span>';
    box.appendChild(b);
  }
}
$('#pads').onclick = e => {
  const x = e.target.closest('[data-x]'); if (x) { e.stopPropagation(); freePad(+x.dataset.x); return; }
  const b = e.target.closest('.pad'); if (!b) return; const i = +b.dataset.i;
  if (!S.pads[i]) { S.addTo = i; $('#padFile').click(); return; }
  trigger(i);
};
$('#padFile').onchange = e => { if (e.target.files[0] && S.addTo != null) makePad(S.addTo, e.target.files[0]); e.target.value = ''; };
$('#addBtn').onclick = () => $('#files').click();
$('#files').onchange = e => { addFiles(e.target.files); e.target.value = ''; };

function trigger(i) {
  const p = S.pads[i]; if (!p) return; const L = S.layers[S.sel]; L.pad = i; L.on = true;
  try { p.v.currentTime = 0; } catch {} p.v.play().catch(() => {}); prune(); renderAll();
}
function prune() { S.pads.forEach((p, i) => { if (!p) return; const used = S.layers.some(L => L.pad === i && L.on); if (used && p.v.paused) p.v.play().catch(() => {}); else if (!used && !p.v.paused) p.v.pause(); }); }

// ---------------------------------------------------------------- layers
function renderLays() {
  $('#lays').innerHTML = S.layers.map((L, n) => { const p = L.pad >= 0 ? S.pads[L.pad] : null; return `<button class="lay${S.sel === n ? ' sel' : ''}${L.on ? '' : ' off'}" data-n="${n}" aria-pressed="${S.sel === n}"><b>${L.id}</b><span>${p ? p.name.replace(/</g, '&lt;') : 'empty'}${L.on ? '' : ' (off)'}</span></button>`; }).join('');
  const L = S.layers[S.sel]; $('#op').value = Math.round(L.op * 100); $('#lon').textContent = L.on ? 'On' : 'Off'; $('#lon').classList.toggle('on', L.on); $('#blend').value = L.blend;
}
function renderAll() { renderPads(); renderLays(); }
$('#lays').onclick = e => { const b = e.target.closest('.lay'); if (b) { S.sel = +b.dataset.n; renderLays(); } };
$('#op').oninput = () => { S.layers[S.sel].op = $('#op').value / 100; };
$('#lon').onclick = () => { const L = S.layers[S.sel]; L.on = !L.on; prune(); renderAll(); };
$('#lclr').onclick = () => { S.layers[S.sel].pad = -1; prune(); renderAll(); };
$('#blend').onchange = () => { S.layers[S.sel].blend = $('#blend').value; };

// ---------------------------------------------------------------- crossfader
const xf = $('#xf');
function setF(f, fromUser) { S.f = clamp(f); if (fromUser) S.auto = null; xf.value = Math.round(S.f * 1000); $('#mix').textContent = S.auto ? 'Mixing…' : (S.f < 0.5 ? 'Mix → B' : 'Mix → A'); }
xf.oninput = () => { S.auto = null; setF(xf.value / 1000); };
function mix() { if (S.auto) return false; S.auto = { from: S.f, to: S.f < 0.5 ? 1 : 0, t0: performance.now(), dur: clamp(+cfg.fadeSec || 4, 0.5, 60) * 1000 }; $('#mix').textContent = 'Mixing…'; return true; }
$('#mix').onclick = mix;

// ---------------------------------------------------------------- beat and effects
const period = () => 60000 / S.bpm;
function setBpm(b) { S.bpm = clamp(Math.round(b * 10) / 10, 40, 220); $('#bpm').value = S.bpm; store.set('bpm', S.bpm); }
function tap() { const now = performance.now(); S.taps.push(now); if (S.taps.length > 12) S.taps.shift(); const b = tapBpm(S.taps); if (b) setBpm(b); S.t0 = now; }
$('#tap').onclick = tap; $('#bpm').onchange = () => setBpm(+$('#bpm').value || 120);
$('#half').onclick = () => setBpm(S.bpm / 2); $('#dbl').onclick = () => setBpm(S.bpm * 2); $('#beat1').onclick = () => { S.t0 = performance.now(); };
function buildFx() {
  $('#fx').innerHTML = FX.map((f, i) => `<button data-i="${i}" class="${S.fx[i] ? 'on' : ''}" aria-pressed="${!!S.fx[i]}">${f.name}</button>`).join('');
}
$('#fx').onclick = e => { const b = e.target.closest('button'); if (!b) return; const i = +b.dataset.i; S.fx[i] = !S.fx[i]; store.set('fxOn', S.fx); buildFx(); };
const savedFx = store.get('fxOn', null); if (savedFx) S.fx = savedFx.slice(0, FX.length).concat(Array(Math.max(0, FX.length - savedFx.length)).fill(false));
$('#fxAmt').value = cfg.fxAmt; $('#fxAmt').oninput = () => { cfg.fxAmt = +$('#fxAmt').value; store.set('cfg', cfg); };

// ---------------------------------------------------------------- drawing
function drawLayer(c, el, W, H, L) {
  const k = (cfg.fit === 'cover' ? Math.max : Math.min)(W / el.videoWidth, H / el.videoHeight), w = el.videoWidth * k, h = el.videoHeight * k;
  c.globalAlpha = L.op; c.globalCompositeOperation = L.blend; c.drawImage(el, (W - w) / 2, (H - h) / 2, w, h);
}
function drawChannel(c, ch) {
  const W = prog.width, H = prog.height; c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  for (const L of S.layers) {
    if (L.ch !== ch || !L.on || L.pad < 0 || L.op <= 0) continue;
    const p = S.pads[L.pad]; if (!p || !p.ready || p.v.readyState < 2 || !p.v.videoWidth) continue; drawLayer(c, p.v, W, H, L);
  }
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
}
function applyFx(now) {
  const W = prog.width, H = prog.height, amt = cfg.fxAmt / 100, ph = beatPos(now, S.t0, period(), 1), env = pulse(ph) * amt, on = i => S.fx[i];
  g.save(); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  if (filterOK) { let f = ''; if (on(6)) f += `hue-rotate(${Math.round(pulse(ph) * 360 * amt)}deg) saturate(${1 + pulse(ph) * amt})`; if (on(7)) f += ` blur(${(pulse(ph) * amt * H * 0.012).toFixed(1)}px)`; if (f) g.filter = f.trim(); }
  let sc = on(0) ? 1 + 0.14 * env : 1, dx = 0, dy = 0;
  if (on(1)) { const m = W * 0.015 * env; dx = (Math.random() * 2 - 1) * m; dy = (Math.random() * 2 - 1) * m; }
  g.translate(W / 2 + dx, H / 2 + dy); g.scale(sc, sc); g.translate(-W / 2, -H / 2); g.drawImage(comp, 0, 0);
  if (on(5)) { g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(comp, 0, 0, W / 2, H, 0, 0, W / 2, H); g.restore(); }
  g.restore(); g.filter = 'none';
  if (on(2) && env > 0.01) { g.globalAlpha = Math.min(1, env * 0.9); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  if (on(3)) { const f = (ph * 2) % 1; if (f > 0.5) { g.globalAlpha = Math.min(1, amt * 1.3); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; } }
  if (on(4) && pulse(ph) * amt > 0.35) { g.globalCompositeOperation = 'difference'; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over'; }
}
function rr(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function drawPoster(now) {
  const s = S.shown; if (!s) return; const fr = posterFrame(now - s.t0, 700, s.hold, 600); if (fr.phase === 'off') { S.shown = null; return; }
  const W = prog.width, H = prog.height, m = H * 0.05, pad = H * 0.022, f1 = H * 0.062, f2 = H * 0.036, ft = 'system-ui,"Segoe UI",Roboto,sans-serif';
  g.save(); g.font = `800 ${f1}px ${ft}`; const w1 = s.l1 ? g.measureText(s.l1).width : 0; g.font = `600 ${f2}px ${ft}`; const w2 = s.l2 ? g.measureText(s.l2).width : 0;
  const bar = H * 0.012, bw = Math.min(W - 2 * m, Math.max(w1, w2) + pad * 2 + bar), bh = pad * 2 + (s.l1 ? f1 * 1.05 : 0) + (s.l2 ? f2 * 1.25 : 0), x = m, y = H - m - bh, ox = -(x + bw + 10) * (1 - fr.p);
  g.translate(ox, 0); g.shadowColor = '#0006'; g.shadowBlur = H * 0.02; g.fillStyle = s.c.bg; rr(x, y, bw, bh, H * 0.012); g.fill(); g.shadowColor = 'transparent'; g.fillStyle = s.c.accent; rr(x, y, bar, bh, H * 0.006); g.fill();
  g.fillStyle = s.c.fg; let ty = y + pad;
  if (s.l1) { g.font = `800 ${f1}px ${ft}`; ty += f1 * 0.85; g.fillText(s.l1, x + pad + bar, ty, bw - 2 * pad - bar); ty += f1 * 0.2; }
  if (s.l2) { g.font = `600 ${f2}px ${ft}`; ty += f2 * 0.95; g.globalAlpha = 0.92; g.fillText(s.l2, x + pad + bar, ty, bw - 2 * pad - bar); }
  g.restore();
}
function drawLogo() { const L = S.logo; if (!L.img || !L.on) return; const W = prog.width, H = prog.height, m = H * 0.04; let h = H * L.size / 100, w = h * L.img.width / L.img.height; if (w > W * 0.3) { w = W * 0.3; h = w * L.img.height / L.img.width; } g.globalAlpha = 1; g.drawImage(L.img, W - m - w, m, w, h); }
let dotsT = 0;
function tick() {
  const now = performance.now(); S.lastTick = now;
  try {
    if (S.auto) { const a = S.auto, p = autoFadePos(a.from, a.to, now - a.t0, a.dur); setF(p); if (now - a.t0 >= a.dur) { S.auto = null; setF(a.to); } }
    drawChannel(gA, 'A'); drawChannel(gB, 'B');
    gc.globalAlpha = 1; gc.fillStyle = '#000'; gc.fillRect(0, 0, comp.width, comp.height);
    if (S.f < 0.999) gc.drawImage(cA, 0, 0);
    if (S.f > 0.001) { gc.globalAlpha = S.f >= 0.999 ? 1 : S.f; gc.drawImage(cB, 0, 0); gc.globalAlpha = 1; }
    applyFx(now); drawPoster(now); drawLogo();
  } catch (e) { S.log.push('draw: ' + e.message); }
  if (now - dotsT > 80) { dotsT = now; const d = $('#dots').children, P = period(), b = Math.floor((now - S.t0) / P), within = ((now - S.t0) % P) / P < 0.25, idx = ((b % 4) + 4) % 4; for (let i = 0; i < 4; i++) d[i].classList.toggle('on', within && i === idx); }
}
let worker = null, fallback = null;
function startTicker() {
  stopTicker(); const ms = Math.round(1000 / (+cfg.fps || 30));
  try { worker = new Worker(URL.createObjectURL(new Blob([`let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`], { type: 'text/javascript' }))); worker.onmessage = tick; worker.postMessage(ms); }
  catch { fallback = setInterval(tick, ms); }
}
function stopTicker() { if (worker) { worker.postMessage(0); worker.terminate(); worker = null; } if (fallback) { clearInterval(fallback); fallback = null; } }
setInterval(() => { if (performance.now() - S.lastTick > 2500) { S.log.push('ticker restarted'); startTicker(); } }, 2000);

// ---------------------------------------------------------------- poster, logo
function showPoster(o = {}) { const p = Object.assign({}, S.poster, o); if (!p.l1 && !p.l2) { toast('Type some text first.'); return; } const c = POSTER_COLORS.find(x => x.id === p.color) || POSTER_COLORS[0]; S.shown = { l1: p.l1, l2: p.l2, c, t0: performance.now(), hold: 8000 }; }
function hidePoster() { const s = S.shown; if (s) s.hold = Math.max(0, Math.min(s.hold, performance.now() - s.t0 - 700)); }
const posterForm = () => { S.poster.l1 = $('#pl1').value; S.poster.l2 = $('#pl2').value; store.set('poster', S.poster); };
$('#colors').innerHTML = POSTER_COLORS.map(c => `<button data-id="${c.id}" style="background:${c.bg};color:${c.fg}" aria-label="${c.name}">Aa</button>`).join('');
const mark = () => document.querySelectorAll('#colors button').forEach(b => b.classList.toggle('sel', b.dataset.id === S.poster.color));
$('#colors').onclick = e => { const b = e.target.closest('button'); if (b) { S.poster.color = b.dataset.id; store.set('poster', S.poster); mark(); } };
$('#pl1').oninput = $('#pl2').oninput = posterForm; $('#pshow').onclick = () => { posterForm(); showPoster(); }; $('#phide').onclick = hidePoster;
$('#logoFile').onchange = e => { const f = e.target.files[0]; if (!f) return; const url = URL.createObjectURL(f), img = new Image(); img.onload = () => { const k = Math.min(1, 500 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); const data = c.toDataURL('image/png'); store.set('logo', data); const i2 = new Image(); i2.onload = () => { S.logo.img = i2; }; i2.src = data; }; img.onerror = () => toast('That file is not an image the browser can read.'); img.src = url; };
$('#logoClear').onclick = () => { S.logo.img = null; store.set('logo', null); };
$('#logoOn').oninput = () => { S.logo.on = $('#logoOn').checked; }; $('#logoSize').oninput = () => { S.logo.size = +$('#logoSize').value; };

// ---------------------------------------------------------------- full screen
const stage = $('#stage');
async function fullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else { await (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage); try { await screen.orientation.lock('landscape'); } catch {} } }
  catch { toast('This browser can not show the picture full screen here. Use your phone\'s screen cast instead.', 5000); }
}
$('#fs').onclick = fullscreen; $('#fsx').onclick = fullscreen; prog.ondblclick = fullscreen;

// ---------------------------------------------------------------- send to another screen
const castStream = () => new MediaStream((S.stream || (S.stream = prog.captureStream(+cfg.fps || 30))).getVideoTracks());
$('#castStart').onclick = async () => {
  if (!window.RTCPeerConnection || !prog.captureStream) { toast('This browser can not send video to another screen.'); return; }
  $('#castStart').disabled = true; $('#castStart').textContent = 'Making code…';
  try {
    if (S.cast) S.cast.close();
    const r = await makeOffer(castStream()); S.cast = r.pc; $('#offerBox').value = r.code; $('#castStep2').style.display = '';
    S.cast.onconnectionstatechange = () => { const s = S.cast.connectionState; $('#castState').textContent = s === 'connected' ? 'Connected ✓' : s; };
    $('#castStart').textContent = '1. Make a new code';
  } catch (e) { toast('Could not make a code: ' + e.message, 6000); $('#castStart').textContent = '1. Make a code'; }
  $('#castStart').disabled = false;
};
const castLink = () => new URL('../live-mobile/receiver.html', location.href).href + '#o=' + encodeURIComponent($('#offerBox').value);
$('#castCopy').onclick = async () => { try { await navigator.clipboard.writeText(castLink()); toast('Link copied.', 1500); } catch { $('#offerBox').select(); toast('Select and copy the code by hand.'); } };
$('#castShare').onclick = async () => { try { if (navigator.share) await navigator.share({ title: 'Spektronautilus receiver', url: castLink() }); else { await navigator.clipboard.writeText(castLink()); toast('Link copied.', 1500); } } catch {} };
$('#castConnect').onclick = async () => { try { if (!S.cast) throw new Error('Make a code first.'); await accept(S.cast, $('#answerBox').value); $('#castState').textContent = 'Connecting…'; } catch (e) { toast(e.message, 6000); } };
$('#castStop').onclick = () => { if (S.cast) { S.cast.close(); S.cast = null; } $('#castState').textContent = 'Stopped'; };

// ---------------------------------------------------------------- settings, startup
for (const id of ['res', 'fps', 'fit', 'fadeSec']) { const el = $('#' + id); el.value = cfg[id]; el.onchange = () => { cfg[id] = id === 'fps' || id === 'fadeSec' ? +el.value : el.value; store.set('cfg', cfg); if (id === 'res') { setRes(); S.stream = null; } if (id === 'fps') startTicker(); }; }
$('#theme').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; store.set('theme', t); };
addEventListener('beforeunload', e => { if (S.pads.some(Boolean)) { e.preventDefault(); e.returnValue = ''; } });
let wl = null; const keep = async () => { try { if (navigator.wakeLock && document.visibilityState === 'visible') wl = await navigator.wakeLock.request('screen'); } catch {} }; document.addEventListener('visibilitychange', keep);
document.documentElement.dataset.theme = store.get('theme', 'dark');
setRes(); $('#pl1').value = S.poster.l1; $('#pl2').value = S.poster.l2; mark(); buildFx(); renderAll(); setBpm(S.bpm);
const lc = store.get('logo', null); if (lc) { const i = new Image(); i.onload = () => { S.logo.img = i; }; i.src = lc; }
setF(0); startTicker(); keep();
Object.assign(window.SPK, { trigger, mix, setF, tap, showPoster, hidePoster, addFiles, tick, makePad });
