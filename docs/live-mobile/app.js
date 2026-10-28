import { clamp, audioGains, onAir, autoFadePos, posterFrame, POSTER_COLORS, parseTitle, fmtTime } from '../live-dj/core.js';
import { makeOffer, accept } from './cast.js';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('spk_lm_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spk_lm_' + k, JSON.stringify(v)); } catch {} },
};
const cfg = Object.assign({ res: '960x540', fps: 30, fit: 'contain', preload: true, audioFollow: true, fadeSec: 4, autoPoster: false, castSound: 'both' }, store.get('cfg', {}));
const S = {
  f: 0, auto: null, lib: [], nextId: 1, decks: {}, audio: null, lastTick: performance.now(), log: [],
  poster: Object.assign({ l1: '', l2: '', color: 'neon' }, store.get('poster', {})), shown: null,
  logo: { img: null, on: true, size: 12 }, fxT: [0, 0, 0, 0, 0], fxOn: [false, false, false, false, false],
  cast: null, stream: null,
};
window.SPK = { S, cfg };
const toastEl = $('#toast'); let toastT;
window.SPK_CHECK_EXTRA = () => [S.lib.length ? { name: 'Tracks', state: 'ok', msg: '{a} track(s) in the list.', a: S.lib.length } : { name: 'Tracks', state: 'warn', msg: 'No tracks yet. Add some videos first.' }];
function toast(m, ms = 3500) { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms); S.log.push(m); }
const safe = (fn, l) => (...a) => { try { return fn(...a); } catch (e) { console.error(l, e); S.log.push('ERR ' + l + ': ' + e.message); } };

// ---------------------------------------------------------------- audio
function ensureAudio() {
  if (S.audio) { if (S.audio.ctx.state === 'suspended') S.audio.ctx.resume().catch(() => {}); return S.audio; }
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  try {
    const ctx = new AC(), master = ctx.createGain(), lim = ctx.createDynamicsCompressor(), local = ctx.createGain(), rec = ctx.createMediaStreamDestination();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.15;
    master.connect(lim); lim.connect(local); local.connect(ctx.destination); lim.connect(rec);
    S.audio = { ctx, master, lim, local, rec };
    for (const id of ['A', 'B']) { const d = S.decks[id]; d.src = ctx.createMediaElementSource(d.el); d.gain = ctx.createGain(); d.src.connect(d.gain); d.gain.connect(master); }
    applyGains(true); applySound();
  } catch (e) { S.audio = null; S.log.push('audio: ' + e.message); }
  return S.audio;
}
function applyGains(now) {
  const g = cfg.audioFollow ? audioGains(S.f) : { a: 1, b: 1 };
  for (const [id, k] of [['A', g.a], ['B', g.b]]) {
    const d = S.decks[id], v = d.vol * k;
    if (S.audio) { if (now) d.gain.gain.value = v; else d.gain.gain.setTargetAtTime(v, S.audio.ctx.currentTime, 0.02); } else d.el.volume = clamp(v);
  }
}
function applySound() { if (S.audio) S.audio.local.gain.value = S.cast && cfg.castSound === 'other' ? 0 : 1; }

// ---------------------------------------------------------------- decks
const MAKE = id => `<div class="card deck" data-deck="${id}"><div class="row"><div class="th"><video id="v${id}" playsinline preload="auto"></video></div>
  <div class="grow" style="min-width:0"><div class="row" style="gap:6px"><b>Deck ${id}</b><span class="chip" id="st${id}">empty</span></div><div class="nm" id="nm${id}">Nothing loaded</div>
  <div class="row" style="margin-top:4px"><button class="main sm" id="pl${id}" disabled>Play</button><button class="sm" id="lp${id}" aria-pressed="false" title="Repeat this video">Loop</button><button class="sm" id="pk${id}">Pick…</button><input type="file" id="fl${id}" accept="video/*" hidden></div></div></div>
  <input type="range" class="seek" id="sk${id}" min="0" max="1000" value="0" aria-label="Position deck ${id}" disabled><div class="tm"><span id="cu${id}">0:00</span><span id="du${id}">0:00</span></div>
  <div class="row"><span class="hint">Volume</span><input class="grow" type="range" id="vo${id}" min="0" max="100" value="100" aria-label="Volume deck ${id}"></div></div>`;
function makeDeck(id) {
  $('#decks').insertAdjacentHTML('beforeend', MAKE(id));
  const el = $('#v' + id), d = S.decks[id] = { id, el, vol: 1, item: null, url: null, token: 0 };
  $('#pl' + id).onclick = () => togglePlay(id);
  $('#lp' + id).onclick = () => { el.loop = !el.loop; $('#lp' + id).classList.toggle('on', el.loop); $('#lp' + id).setAttribute('aria-pressed', el.loop); };
  $('#pk' + id).onclick = () => $('#fl' + id).click();
  $('#fl' + id).onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) { const n = addFiles([f]); if (n) load(id, S.lib[S.lib.length - 1]); } };
  $('#vo' + id).oninput = e => { d.vol = e.target.value / 100; applyGains(); };
  const sk = $('#sk' + id); sk.oninput = () => { if (isFinite(el.duration)) el.currentTime = el.duration * sk.value / 1000; };
  el.addEventListener('error', () => { if (d.item) { toast(`Deck ${id} can't play “${d.item.name}”. Use an mp4 (H.264) video.`, 6000); eject(id); } });
  for (const ev of ['play', 'pause', 'ended', 'loadedmetadata']) el.addEventListener(ev, () => updateDeck(id));
}
async function load(id, item) {
  const d = S.decks[id], tok = ++d.token; ensureAudio(); d.el.pause();
  $('#st' + id).textContent = 'loading…'; $('#nm' + id).textContent = item.name;
  let blob = item.file;
  try { if (cfg.preload && item.file.size < 400e6) blob = new Blob([await item.file.arrayBuffer()], { type: item.file.type || 'video/mp4' }); } catch { blob = item.file; }
  if (tok !== d.token) return false;
  if (d.url) URL.revokeObjectURL(d.url);
  d.url = URL.createObjectURL(blob); d.item = item; d.el.src = d.url; d.el.load();
  const ok = await new Promise(res => { const done = v => { clearTimeout(t); d.el.removeEventListener('loadedmetadata', a); d.el.removeEventListener('error', b); res(v); }, a = () => done(true), b = () => done(false), t = setTimeout(() => done(false), 20000); if (d.el.readyState >= 1) done(true); else { d.el.addEventListener('loadedmetadata', a); d.el.addEventListener('error', b); } });
  if (tok !== d.token) return false;
  if (!ok) { eject(id); return false; }
  d.el.currentTime = 0; updateDeck(id); renderBin(); return true;
}
function eject(id) { const d = S.decks[id]; d.token++; d.el.pause(); d.el.removeAttribute('src'); d.el.load(); if (d.url) URL.revokeObjectURL(d.url); d.url = null; d.item = null; updateDeck(id); renderBin(); }
function togglePlay(id) { const d = S.decks[id]; if (!d.item) { toast(`Load a video on deck ${id} first.`); return; } ensureAudio(); if (d.el.paused) d.el.play().catch(e => toast(`Deck ${id}: ${e.message}`)); else d.el.pause(); }
function updateDeck(id) {
  const d = S.decks[id], has = !!d.item, el = d.el, live = has && !el.paused && (onAir(S.f) === id || (S.f > .02 && S.f < .98));
  $('#nm' + id).textContent = has ? d.item.name : 'Nothing loaded'; $('#pl' + id).disabled = !has; $('#sk' + id).disabled = !has; $('#pl' + id).textContent = has && !el.paused ? 'Pause' : 'Play';
  const st = $('#st' + id); st.textContent = !has ? 'empty' : live ? 'on air' : el.paused ? 'cued' : 'playing'; st.className = 'chip' + (live ? ' live' : ''); $('#du' + id).textContent = fmtTime(el.duration);
}

// ---------------------------------------------------------------- clips
function addFiles(files) {
  let n = 0;
  for (const f of files) { if (!(f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(f.name))) continue; const t = parseTitle(f.name); S.lib.push({ id: S.nextId++, file: f, name: t.artist ? `${t.artist} – ${t.title}` : t.title, size: f.size }); n++; }
  renderBin(); return n;
}
function renderBin() {
  const box = $('#bin'); if (!S.lib.length) { box.innerHTML = '<span class="hint">No videos yet.</span>'; return; } box.innerHTML = '';
  S.lib.forEach((it, i) => { const on = ['A', 'B'].filter(k => S.decks[k] && S.decks[k].item === it).join(''), r = document.createElement('div'); r.className = 'li';
    r.innerHTML = `<span class="t">${on ? `<span class="chip live">${on}</span> ` : ''}</span><button class="sm" data-a="A">→ A</button><button class="sm" data-a="B">→ B</button><button class="sm" data-a="x" aria-label="Remove">✕</button>`;
    r.querySelector('.t').appendChild(document.createTextNode(it.name));
    r.onclick = e => { const a = e.target.dataset.a; if (a === 'A' || a === 'B') load(a, it); else if (a === 'x') { for (const k of ['A', 'B']) if (S.decks[k].item === it) eject(k); S.lib.splice(i, 1); renderBin(); } };
    box.appendChild(r); });
}
$('#addBtn').onclick = () => $('#files').click();
$('#files').onchange = e => { const n = addFiles(e.target.files); e.target.value = ''; if (n) toast(`${n} video${n > 1 ? 's' : ''} added.`, 1600); };

// ---------------------------------------------------------------- crossfader
const xf = $('#xf');
function setF(f, user) { S.f = clamp(f); if (user) S.auto = null; xf.value = Math.round(S.f * 1000); applyGains(); $('#mix').textContent = S.auto ? 'Mixing…' : (S.f < .5 ? 'Mix → B' : 'Mix → A'); }
xf.oninput = () => { S.auto = null; setF(xf.value / 1000); };
function mix() {
  if (S.auto) return false; const to = S.f < .5 ? 1 : 0, inc = to ? 'B' : 'A', d = S.decks[inc];
  if (!d.item) { toast(`Load a video on deck ${inc} first.`); return false; } ensureAudio(); if (d.el.paused) d.el.play().catch(() => {});
  S.auto = { from: S.f, to, t0: performance.now(), dur: clamp(+cfg.fadeSec || 4, 1, 60) * 1000, out: to ? 'A' : 'B' };
  if (cfg.autoPoster) { const t = parseTitle(d.item.name); showPoster({ l1: t.artist || t.title, l2: t.artist ? t.title : '' }); }
  $('#mix').textContent = 'Mixing…'; return true;
}
function finishFade() { const a = S.auto; S.auto = null; setF(a.to); const o = S.decks[a.out]; if (o.item) o.el.pause(); updateDeck('A'); updateDeck('B'); }
$('#mix').onclick = mix;

// ---------------------------------------------------------------- effects (hold a button)
const FXN = ['Flash', 'Strobe', 'Invert', 'Zoom', 'Mirror'];
$('#fx').innerHTML = FXN.map((n, i) => `<button data-i="${i}">${n}</button>`).join('');
const fxSet = (i, on) => { if (on && !S.fxOn[i]) S.fxT[i] = performance.now(); S.fxOn[i] = on; document.querySelector(`#fx [data-i="${i}"]`).classList.toggle('hold', on); };
$('#fx').addEventListener('pointerdown', e => { const b = e.target.closest('button'); if (b) { e.preventDefault(); b.setPointerCapture && b.setPointerCapture(e.pointerId); fxSet(+b.dataset.i, true); } });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#fx').addEventListener(ev, e => { const b = e.target.closest('button'); if (b) fxSet(+b.dataset.i, false); });
$('#fx').addEventListener('contextmenu', e => e.preventDefault());

// ---------------------------------------------------------------- drawing
const prog = $('#prog'), g = prog.getContext('2d', { alpha: false }), comp = document.createElement('canvas'), gc = comp.getContext('2d', { alpha: false });
function setRes() { const [w, h] = cfg.res.split('x').map(Number); prog.width = comp.width = w; prog.height = comp.height = h; }
function drawDeck(c, d, alpha) { const el = d.el; if (!d.item || el.readyState < 2 || !el.videoWidth) return; const W = prog.width, H = prog.height, k = (cfg.fit === 'cover' ? Math.max : Math.min)(W / el.videoWidth, H / el.videoHeight), w = el.videoWidth * k, h = el.videoHeight * k; c.globalAlpha = alpha; c.drawImage(el, (W - w) / 2, (H - h) / 2, w, h); c.globalAlpha = 1; }
function rr(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function drawPoster(now) {
  const s = S.shown; if (!s) return; const fr = posterFrame(now - s.t0, 700, s.hold, 600); if (fr.phase === 'off') { S.shown = null; return; }
  const W = prog.width, H = prog.height, m = H * .05, pad = H * .022, f1 = H * .062, f2 = H * .036, ft = 'system-ui,"Segoe UI",Roboto,sans-serif';
  g.save(); g.font = `800 ${f1}px ${ft}`; const w1 = s.l1 ? g.measureText(s.l1).width : 0; g.font = `600 ${f2}px ${ft}`; const w2 = s.l2 ? g.measureText(s.l2).width : 0;
  const bar = H * .012, bw = Math.min(W - 2 * m, Math.max(w1, w2) + pad * 2 + bar), bh = pad * 2 + (s.l1 ? f1 * 1.05 : 0) + (s.l2 ? f2 * 1.25 : 0), x = m, y = H - m - bh;
  g.translate(-(x + bw + 10) * (1 - fr.p), 0); g.shadowColor = '#0006'; g.shadowBlur = H * .02; g.fillStyle = s.c.bg; rr(x, y, bw, bh, H * .012); g.fill(); g.shadowColor = 'transparent'; g.fillStyle = s.c.accent; rr(x, y, bar, bh, H * .006); g.fill();
  g.fillStyle = s.c.fg; let ty = y + pad;
  if (s.l1) { g.font = `800 ${f1}px ${ft}`; ty += f1 * .85; g.fillText(s.l1, x + pad + bar, ty, bw - 2 * pad - bar); ty += f1 * .2; }
  if (s.l2) { g.font = `600 ${f2}px ${ft}`; ty += f2 * .95; g.fillText(s.l2, x + pad + bar, ty, bw - 2 * pad - bar); }
  g.restore();
}
function tick() {
  const now = performance.now(); S.lastTick = now;
  try {
    if (S.auto) { const a = S.auto; setF(autoFadePos(a.from, a.to, now - a.t0, a.dur)); if (now - a.t0 >= a.dur) finishFade(); }
    const W = prog.width, H = prog.height;
    gc.fillStyle = '#000'; gc.fillRect(0, 0, W, H);
    if (S.f < .999) drawDeck(gc, S.decks.A, 1);
    if (S.f > .001) drawDeck(gc, S.decks.B, S.f >= .999 ? 1 : S.f);
    const on = S.fxOn; let sc = 1;
    if (on[3]) sc = 1 + .15 * Math.min(1, (now - S.fxT[3]) / 200);
    g.save(); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.translate(W / 2, H / 2); g.scale(sc, sc); g.translate(-W / 2, -H / 2); g.drawImage(comp, 0, 0);
    if (on[4]) { g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(comp, 0, 0, W / 2, H, 0, 0, W / 2, H); g.restore(); }
    g.restore();
    if (on[0]) { g.globalAlpha = Math.max(.25, 1 - (now - S.fxT[0]) / 500); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
    if (on[1] && Math.floor((now - S.fxT[1]) / 80) % 2 === 1) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
    if (on[2]) { g.globalCompositeOperation = 'difference'; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over'; }
    drawPoster(now);
    const L = S.logo; if (L.img && L.on) { const m = H * .04; let h = H * L.size / 100, w = h * L.img.width / L.img.height; if (w > W * .3) { w = W * .3; h = w * L.img.height / L.img.width; } g.drawImage(L.img, W - m - w, m, w, h); }
  } catch (e) { S.log.push('draw: ' + e.message); }
  if (now - (tick.u || 0) > 300) { tick.u = now; safe(() => { for (const id of ['A', 'B']) { const d = S.decks[id], el = d.el; if (!d.item) continue; $('#cu' + id).textContent = fmtTime(el.currentTime); $('#du' + id).textContent = fmtTime(el.duration); if (document.activeElement !== $('#sk' + id) && isFinite(el.duration)) $('#sk' + id).value = Math.round(el.currentTime / el.duration * 1000); updateDeck(id); } }, 'ui')(); }
}
let worker = null, fb = null;
function startTicker() { stopTicker(); const ms = Math.round(1000 / (+cfg.fps || 30)); try { worker = new Worker(URL.createObjectURL(new Blob([`let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`], { type: 'text/javascript' }))); worker.onmessage = tick; worker.postMessage(ms); } catch { fb = setInterval(tick, ms); } }
function stopTicker() { if (worker) { worker.postMessage(0); worker.terminate(); worker = null; } if (fb) { clearInterval(fb); fb = null; } }
setInterval(() => { if (performance.now() - S.lastTick > 3000) { S.log.push('ticker restarted'); startTicker(); } }, 2500);

// ---------------------------------------------------------------- poster, logo
function showPoster(o = {}) { const p = Object.assign({}, S.poster, o); if (!p.l1 && !p.l2) { toast('Type some text first.'); return; } const c = POSTER_COLORS.find(x => x.id === p.color) || POSTER_COLORS[0]; S.shown = { l1: p.l1, l2: p.l2, c, t0: performance.now(), hold: 8000 }; }
function hidePoster() { const s = S.shown; if (s) s.hold = Math.max(0, Math.min(s.hold, performance.now() - s.t0 - 700)); }
const posterForm = () => { S.poster.l1 = $('#pl1').value; S.poster.l2 = $('#pl2').value; store.set('poster', S.poster); };
$('#colors').innerHTML = POSTER_COLORS.map(c => `<button data-id="${c.id}" style="background:${c.bg};color:${c.fg}" aria-label="${c.name}">Aa</button>`).join('');
const mark = () => document.querySelectorAll('#colors button').forEach(b => b.classList.toggle('sel', b.dataset.id === S.poster.color));
$('#colors').onclick = e => { const b = e.target.closest('button'); if (b) { S.poster.color = b.dataset.id; store.set('poster', S.poster); mark(); } };
$('#pl1').oninput = $('#pl2').oninput = posterForm; $('#pshow').onclick = () => { posterForm(); showPoster(); }; $('#phide').onclick = hidePoster;
$('#logoFile').onchange = e => { const f = e.target.files[0]; if (!f) return; const url = URL.createObjectURL(f), img = new Image(); img.onload = () => { const k = Math.min(1, 500 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); const data = c.toDataURL('image/png'); store.set('logo', data); const i2 = new Image(); i2.onload = () => { S.logo.img = i2; }; i2.src = data; }; img.onerror = () => toast('That is not an image I can read.'); img.src = url; };
$('#logoClear').onclick = () => { S.logo.img = null; store.set('logo', null); };
$('#logoOn').oninput = () => { S.logo.on = $('#logoOn').checked; }; $('#logoSize').oninput = () => { S.logo.size = +$('#logoSize').value; };

// ---------------------------------------------------------------- full screen
const stage = $('#stage');
async function fullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else { await (stage.requestFullscreen || stage.webkitRequestFullscreen).call(stage); try { await screen.orientation.lock('landscape'); } catch {} } }
  catch { toast('This browser can not show the picture full screen here. Use your phone\'s screen cast instead.', 5000); }
}
$('#fs').onclick = fullscreen; $('#fsx').onclick = fullscreen; $('#stage canvas').ondblclick = fullscreen;

// ---------------------------------------------------------------- send to another screen
function castStream() {
  const v = S.stream || (S.stream = prog.captureStream(+cfg.fps || 30)), a = S.audio ? S.audio.rec.stream.getAudioTracks() : [];
  return new MediaStream([...v.getVideoTracks(), ...a]);
}
$('#castStart').onclick = async () => {
  if (!window.RTCPeerConnection || !prog.captureStream) { toast('This browser can not send video to another screen.'); return; }
  ensureAudio(); $('#castStart').disabled = true; $('#castStart').textContent = 'Making code…';
  try {
    if (S.cast) S.cast.close();
    const r = await makeOffer(castStream()); S.cast = r.pc; $('#offerBox').value = r.code; $('#castStep2').style.display = '';
    S.cast.onconnectionstatechange = () => { const s = S.cast.connectionState; $('#castState').textContent = s === 'connected' ? 'Connected ✓' : s; applySound(); };
    $('#castStart').textContent = '1. Make a new code';
  } catch (e) { toast('Could not make a code: ' + e.message, 6000); $('#castStart').textContent = '1. Make a code'; }
  $('#castStart').disabled = false;
};
const castLink = () => new URL('receiver.html', location.href).href + '#o=' + encodeURIComponent($('#offerBox').value);
$('#castCopy').onclick = async () => { try { await navigator.clipboard.writeText(castLink()); toast('Link copied.', 1500); } catch { $('#offerBox').select(); toast('Select and copy the code by hand.'); } };
$('#castShare').onclick = async () => { try { if (navigator.share) await navigator.share({ title: 'Spektronautilus receiver', url: castLink() }); else { await navigator.clipboard.writeText(castLink()); toast('Link copied.', 1500); } } catch {} };
$('#castConnect').onclick = async () => { try { if (!S.cast) throw new Error('Make a code first.'); await accept(S.cast, $('#answerBox').value); $('#castState').textContent = 'Connecting…'; } catch (e) { toast(e.message, 6000); } };
$('#castStop').onclick = () => { if (S.cast) { S.cast.close(); S.cast = null; } $('#castState').textContent = 'Stopped'; applySound(); };
$('#castSound').value = cfg.castSound; $('#castSound').onchange = () => { cfg.castSound = $('#castSound').value; store.set('cfg', cfg); applySound(); };

// ---------------------------------------------------------------- settings, startup
for (const id of ['res', 'fps', 'fit', 'fadeSec']) { const el = $('#' + id); el.value = cfg[id]; el.onchange = () => { cfg[id] = id === 'fps' || id === 'fadeSec' ? +el.value : el.value; store.set('cfg', cfg); if (id === 'res') { setRes(); S.stream = null; } if (id === 'fps') startTicker(); }; }
for (const id of ['preload', 'audioFollow', 'autoPoster']) { const el = $('#' + id); el.checked = cfg[id]; el.onchange = () => { cfg[id] = el.checked; store.set('cfg', cfg); if (id === 'audioFollow') applyGains(); }; }
$('#theme').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; store.set('theme', t); };
addEventListener('pointerdown', () => ensureAudio(), { passive: true });
addEventListener('beforeunload', e => { if (S.decks.A.item || S.decks.B.item) { e.preventDefault(); e.returnValue = ''; } });
let wl = null; const keep = async () => { try { if (navigator.wakeLock && document.visibilityState === 'visible') wl = await navigator.wakeLock.request('screen'); } catch {} }; document.addEventListener('visibilitychange', keep);

document.documentElement.dataset.theme = store.get('theme', 'dark');
makeDeck('A'); makeDeck('B'); setRes(); $('#pl1').value = S.poster.l1; $('#pl2').value = S.poster.l2; mark(); renderBin();
const lc = store.get('logo', null); if (lc) { const i = new Image(); i.onload = () => { S.logo.img = i; }; i.src = lc; }
setF(0); startTicker(); keep();
Object.assign(window.SPK, { load, mix, setF, togglePlay, showPoster, hidePoster, addFiles, tick, fxSet, eject });
