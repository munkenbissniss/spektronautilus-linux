// The shared job queue. Every tool and mixer reports its jobs here, and the Queue page shows them all in one place.
// Pages talk over a BroadcastChannel (live progress), and finished jobs are remembered in IndexedDB (history and result files).
// Only this browser on this computer sees them. Nothing is sent anywhere.
const DB = 'spk_queue', CHAN = 'spk-queue', STALE = 90000, BLOB_CAP = 600e6;
export const ACTIVE = ['queued', 'running'];
const tab = Math.random().toString(36).slice(2, 8);
let chan = null; try { chan = new BroadcastChannel(CHAN); } catch {}
const handlers = { cancel: [], pause: [], update: [] }, last = new Map(), own = new Map();

const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => { r.result.createObjectStore('jobs', { keyPath: 'key' }); r.result.createObjectStore('blobs'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = async (store, mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(store, mode), s = t.objectStore(store); let out; try { out = fn(s); } catch (e) { rej(e); return; } t.oncomplete = () => { db.close(); res(out && out.result !== undefined ? out.result : out); }; t.onerror = () => rej(t.error); }); };

// The menu badge shows how many jobs run in ALL tabs: each tab writes its own count, the badge number is the sum of the recent ones.
function publishCount(now) {
  try {
    localStorage.setItem('spk_qt_' + tab, JSON.stringify({ n: own.size, t: now }));
    let sum = 0; for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (!k || k.indexOf('spk_qt_') !== 0) continue;
      let o = {}; try { o = JSON.parse(localStorage.getItem(k)) || {}; } catch {} if (now - (o.t || 0) < 30000) sum += o.n || 0; else localStorage.removeItem(k); }
    localStorage.setItem('spk_q', JSON.stringify({ n: sum, t: now }));
  } catch {}
}
// job: { id, app, appLabel, url, title, status: queued|running|done|failed|cancelled, progress 0..1, done, total, failed, current, error, results:[{name,size}], canCancel }
export function report(job) {
  const key = tab + ':' + job.app + ':' + job.id, now = Date.now();
  const j = { ...job, key, tab, updated: now, created: job.created || last.get(key)?.created || now };
  const prev = last.get(key); last.set(key, { created: j.created, status: j.status, t: now });
  if (ACTIVE.includes(j.status)) own.set(key, j); else own.delete(key);
  try { chan && chan.postMessage({ t: 'job', job: j }); } catch {}
  publishCount(now);
  if (!prev || prev.status !== j.status) tx('jobs', 'readwrite', s => s.put(j)).catch(() => {});
  return key;
}
export async function saveResults(key, files) {                       // files: [{name, blob}]
  let total = 0; for (const f of files) total += f.blob.size;
  if (total > BLOB_CAP) return false;
  try { await tx('blobs', 'readwrite', s => { files.forEach(f => s.put(f.blob, key + '|' + f.name)); }); return true; } catch { return false; }
}
export async function list() { try { return (await tx('jobs', 'readonly', s => s.getAll())) || []; } catch { return []; } }
export async function getBlob(key, name) { try { return await tx('blobs', 'readonly', s => s.get(key + '|' + name)); } catch { return null; } }
export async function remove(job) {
  try { await tx('jobs', 'readwrite', s => s.delete(job.key)); const db = await idb(); const t = db.transaction('blobs', 'readwrite'), s = t.objectStore('blobs');
    await Promise.all((job.results || []).map(r => new Promise(res => { const q = s.delete(job.key + '|' + r.name); q.onsuccess = q.onerror = res; }))); db.close(); } catch {}
}
// Heartbeat: a running job is announced again every few seconds even when its page has nothing new to say (a long step without progress),
// and a Queue page opened later asks "hello" and gets every running job at once. A worker keeps the beat when the tab is in the background.
function beat() { const now = Date.now(); own.forEach((j, key) => { const x = { ...j, updated: now }; own.set(key, x); try { chan && chan.postMessage({ t: 'job', job: x }); } catch {} const l = last.get(key); if (l) l.t = now; });
  if (own.size) publishCount(now); }
try { const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(1),4000)'], { type: 'text/javascript' }))); w.onmessage = beat; } catch { setInterval(beat, 4000); }
export const hello = () => { try { chan && chan.postMessage({ t: 'hello' }); } catch {} };
export function onPause(fn) { handlers.pause.push(fn); }
export function requestPause(key, on) { try { chan && chan.postMessage({ t: 'pause', key, on: !!on }); } catch {} }
export const isStale = j => ACTIVE.includes(j.status) && Date.now() - j.updated > STALE;
// the page that owns a job listens for stop requests: fn(app, id)
export function onCancel(fn) { handlers.cancel.push(fn); }
export function requestCancel(key) { try { chan && chan.postMessage({ t: 'cancel', key }); } catch {} }
export function onUpdate(fn) { handlers.update.push(fn); }
if (chan) chan.onmessage = e => {
  const m = e.data; if (!m) return;
  if (m.t === 'cancel' && last.has(m.key)) { const p = m.key.split(':'); handlers.cancel.forEach(f => f(p[1], p.slice(2).join(':'))); }
  if (m.t === 'pause' && last.has(m.key)) { const p = m.key.split(':'); handlers.pause.forEach(f => f(p[1], p.slice(2).join(':'), m.on)); }
  if (m.t === 'hello') own.forEach(j => { try { chan.postMessage({ t: 'job', job: { ...j, updated: Date.now() } }); } catch {} });
  if (m.t === 'job') handlers.update.forEach(f => f(m.job));
};
export const ownKey = (app, id) => tab + ':' + app + ':' + id;
