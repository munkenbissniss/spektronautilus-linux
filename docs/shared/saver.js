// Battery saving for the phone mixers: the picture is only drawn when something moves, and not at all when nobody can see it.
// moving(): a clip plays, a fade runs, a poster or an effect is on.  sending(): the picture goes to another screen (then it must keep going).
// When nothing moves, the picture is still refreshed every idleMs (a file that has finished loading, a logo, a setting), and at once
// for a short while after any tap, key or slider.
export function makeSaver({ moving, sending = () => false, idleMs = 500, hotMs = 700 }) {
  let last = -1e9, hot = 0;
  const poke = () => { hot = performance.now() + hotMs; };
  for (const ev of ['pointerdown', 'pointerup', 'input', 'change', 'keydown']) addEventListener(ev, poke, { capture: true, passive: true });
  document.addEventListener('visibilitychange', poke);
  const away = () => document.visibilityState === 'hidden' && !sending();
  return {
    poke, away,
    stats: { drawn: 0, skipped: 0 },
    draw(now = performance.now()) {
      let d = false;
      if (!away()) {
        let m = false; try { m = !!moving(); } catch (e) { m = true; }
        d = m || now < hot || now - last >= idleMs;
      }
      if (d) { last = now; this.stats.drawn++; } else this.stats.skipped++;
      return d;
    },
  };
}
