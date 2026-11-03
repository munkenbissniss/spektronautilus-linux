// Shared progress helpers: one look and one set of rules for every progress bar on the site.
//   barHTML({ frac, running, paused })  a bar that is empty and "alive" (moving stripes) while nothing is known yet, and still while paused
//   timeLine(job)                       "42% · 1:20 elapsed · about 2:05 left"  (the estimate only shows when it is trustworthy)
//   fmtDur(seconds)                     "1:05" or "1:02:03"
// Rules: the bar never goes backwards, never leaves 0..1, and says "Paused" in words, not only by standing still.
const CSS = `.bar{position:relative}.bar i{display:block;height:100%;min-width:0}
.bar.ind i,.prog.ind i{width:35%!important;background:repeating-linear-gradient(45deg,var(--b) 0 10px,color-mix(in srgb,var(--b) 55%,transparent) 10px 20px);animation:spkind 1.1s linear infinite;transition:none}
.bar.pz i,.prog.pz i{opacity:.45}
@keyframes spkind{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
@media (prefers-reduced-motion:reduce){.bar.ind i,.prog.ind i{animation:none;width:100%!important;opacity:.5}}
.ptime{font-size:.82rem;color:var(--mute);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}`;
export function injectCSS() { if (document.getElementById('spk-prog-css')) return; const s = document.createElement('style'); s.id = 'spk-prog-css'; s.textContent = CSS; document.head.append(s); }
export const clamp01 = x => (x >= 0 && x <= 1) ? x : (x > 1 ? 1 : 0);
export function fmtDur(s) { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; }
export function barHTML({ frac = 0, running = true, paused = false } = {}) {
  const f = clamp01(frac || 0), ind = running && !paused && f <= 0.002;
  return `<div class="bar${ind ? ' ind' : ''}${paused ? ' pz' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${ind ? '' : `aria-valuenow="${Math.round(f * 100)}"`}><i style="width:${Math.round(f * 1000) / 10}%"></i></div>`;
}
// job: { progress 0..1, started (ms), paused, pauseStart (ms, while paused), pausedMs (time spent paused before), status }
const TT = s => (typeof window !== 'undefined' && window.SPK_T) ? window.SPK_T(s) : s;
export function timeLine(j, T = TT) {
  if (!j || !j.started) return '';
  const now = Date.now(), pz = (j.pausedMs || 0) + (j.paused && j.pauseStart ? now - j.pauseStart : 0), el = Math.max(0, (now - j.started - pz) / 1000), f = clamp01(j.progress || 0);
  const parts = [];
  if (f > 0) parts.push(Math.floor(f * 100) + '%');
  parts.push(T('{a} elapsed').replace('{a}', fmtDur(el)));
  if (!j.paused && f >= 0.03 && el >= 8 && f < 1) parts.push(T('about {a} left').replace('{a}', fmtDur(el * (1 - f) / f)));
  return parts.join(' · ');
}
// "nothing has changed for a while" -> a calm sentence, so nobody thinks it froze
export function quietNote(lastChange, T = TT, after = 20000) { return lastChange && Date.now() - lastChange > after ? T('Still working. Big files can take a while without moving the bar.') : ''; }
