/* Demoscene-style effects for the Magic Video Mixer (plasma, copper bars, tunnel echo, raster wobble, pixel crunch,
   RGB split, starfield, scroller, old screen). Everything draws on the 2D canvas of the mixer, after the clips are mixed,
   and is locked to the music by the caller (ctx.kk = 0..1 beat envelope, ctx.m = time in seconds). All amounts 0 = off. */
(function () {
  const TAU = Math.PI * 2, clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  const cnv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const NAMES = ['dPlasma', 'dBars', 'dFeedback', 'dWobble', 'dMosaic', 'dChroma', 'dStars', 'dScan', 'dText', 'dBloom', 'dGrain', 'dFlash', 'dBox'];
  function create(W, H, seed) {
    const sc = cnv(W, H), scg = sc.getContext('2d'), tint = cnv(W, H), tg = tint.getContext('2d'), prev = cnv(W, H), pg = prev.getContext('2d');
    const pl = cnv(80, 45), plg = pl.getContext('2d'), plD = plg.createImageData(80, 45), small = cnv(8, 8), sg = small.getContext('2d');
    const N = 260, sx = new Float32Array(N), sy = new Float32Array(N), sz = new Float32Array(N);
    for (let i = 0; i < N; i++) { sx[i] = hash(i * 3.1 + seed) * 2 - 1; sy[i] = hash(i * 5.7 + seed + 9) * 2 - 1; sz[i] = hash(i * 7.3 + seed + 4); }
    let hasPrev = false, lastM = 0, cw = 0, cwFont = '', vg = null, scanPat = null, grainPat = null;
    const bl1 = cnv(8, 8), b1 = bl1.getContext('2d'), bl2 = cnv(8, 8), b2 = bl2.getContext('2d');
    const wt = (o, c, name) => { const a = name === 'dText' ? (String(o.dText || '').trim() ? 1 : 0) : +o[name] || 0; if (a <= 0) return 0;
      const v = +o.dVar || 0, i = NAMES.indexOf(name), mk = ci => v > 0 ? (hash((ci || 0) * 13.7 + i * 5.1 + seed) < 1 - v * .7 ? 1 : 0) : 1;
      return a * (mk(c.pci) * (1 - c.fx) + mk(c.ci) * c.fx); };
    function apply(g, cv, o, c) {
      const m = c.m, kk = clamp(c.kk, 0, 1), dt = clamp(m - lastM, 0, .1); lastM = m;
      // tunnel echo: the last picture, a little bigger and turned, is blended back in
      let a = wt(o, c, 'dFeedback');
      if (a > 0) {
        if (hasPrev) { g.save(); g.globalCompositeOperation = 'lighten'; g.globalAlpha = clamp(.5 + .4 * a, 0, .92); g.translate(W / 2, H / 2);
          const zz = 1 + .008 + .03 * a * (1 + kk); g.rotate(.004 * a * Math.sin(m * .6) + .008 * a * kk); g.scale(zz, zz); g.drawImage(prev, -W / 2, -H / 2); g.restore(); }
        pg.drawImage(cv, 0, 0); hasPrev = true;
      } else hasPrev = false;
      // raster wobble: horizontal stripes slide sideways in a wave
      a = wt(o, c, 'dWobble');
      if (a > 0) {
        scg.drawImage(cv, 0, 0); const n = 48, sh = Math.ceil(H / n), amp = W * (.004 + .02 * a * (.4 + kk));
        for (let i = 0; i < n; i++) { const y = i * sh, off = amp * Math.sin(i * .35 + m * 3.1) + amp * .5 * Math.sin(i * .9 - m * 5); g.drawImage(sc, 0, y, W, sh, off - amp * 1.6, y, W + amp * 3.2, sh); }
      }
      // pixel crunch on the beat
      a = wt(o, c, 'dMosaic');
      if (a > 0) {
        const b = Math.floor(1 + a * kk * W / 40);
        if (b >= 3) { const w = Math.ceil(W / b), h = Math.ceil(H / b); small.width = w; small.height = h; sg.imageSmoothingEnabled = true; sg.drawImage(cv, 0, 0, w, h);
          g.imageSmoothingEnabled = false; g.drawImage(small, 0, 0, w, h, 0, 0, W, H); g.imageSmoothingEnabled = true; }
      }
      // RGB split
      a = wt(o, c, 'dChroma');
      if (a > 0) {
        const d = W * (.002 + .012 * kk) * a;
        if (d > .6) {
          scg.drawImage(cv, 0, 0); g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'lighter';
          for (const [col, dx, dy] of [['#f00', d, 0], ['#0f0', 0, 0], ['#00f', -d, d * .25]]) {
            tg.globalCompositeOperation = 'source-over'; tg.drawImage(sc, 0, 0); tg.globalCompositeOperation = 'multiply'; tg.fillStyle = col; tg.fillRect(0, 0, W, H); g.drawImage(tint, dx, dy);
          }
          g.globalCompositeOperation = 'source-over';
        }
      }
      // plasma wash
      a = wt(o, c, 'dPlasma');
      if (a > 0) {
        const t = m, ph = c.hue * Math.PI / 180, d = plD.data;
        for (let y = 0; y < 45; y++) for (let x = 0; x < 80; x++) {
          const v = Math.sin(x * .16 + t * .9) + Math.sin(y * .22 - t * 1.3) + Math.sin((x + y) * .1 + t * .6) + Math.sin(Math.hypot(x - 40 + 14 * Math.sin(t * .4), y - 22 + 8 * Math.cos(t * .5)) * .2 - t * 1.1), q = v * .7 + t * .2, i = (y * 80 + x) * 4;
          d[i] = 128 + 127 * Math.sin(q + ph); d[i + 1] = 128 + 127 * Math.sin(q + ph + 2.1); d[i + 2] = 128 + 127 * Math.sin(q + ph + 4.2); d[i + 3] = 255;
        }
        plg.putImageData(plD, 0, 0); g.save(); g.imageSmoothingEnabled = true;
        g.globalCompositeOperation = 'screen'; g.globalAlpha = clamp(a * (.16 + .3 * kk), 0, .8); g.drawImage(pl, 0, 0, W, H);
        g.globalCompositeOperation = 'overlay'; g.globalAlpha = clamp(a * .35, 0, .8); g.drawImage(pl, 0, 0, W, H); g.restore();
      }
      // copper bars
      a = wt(o, c, 'dBars');
      if (a > 0) {
        g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = clamp(a * (.3 + .5 * kk), 0, 1);
        for (let i = 0; i < 7; i++) {
          const y = H * (.5 + .38 * Math.sin(m * .7 + i * .62)), bh = H * .045 * (1 + .6 * kk), hu = (c.hue + i * 14) % 360, gr = g.createLinearGradient(0, y - bh, 0, y + bh);
          gr.addColorStop(0, `hsla(${hu},95%,50%,0)`); gr.addColorStop(.5, `hsla(${hu},95%,66%,1)`); gr.addColorStop(1, `hsla(${hu},95%,50%,0)`); g.fillStyle = gr; g.fillRect(0, y - bh, W, bh * 2);
        }
        g.restore();
      }
      // starfield flying towards you
      a = wt(o, c, 'dStars');
      if (a > 0) {
        const n = Math.floor(60 + (N - 60) * a), sp = (.25 + 1.6 * kk) * dt * (.6 + a) * .4, K = W * .18;
        g.save(); g.globalCompositeOperation = 'lighter'; g.strokeStyle = `hsl(${c.hue},55%,86%)`; g.lineCap = 'round';
        for (let i = 0; i < n; i++) {
          sz[i] -= sp; if (sz[i] <= .03) { sx[i] = hash(i * 3.1 + m * 7) * 2 - 1; sy[i] = hash(i * 5.7 + m * 3) * 2 - 1; sz[i] = 1; }
          const z = sz[i], z0 = z + sp * 2 + .004, x1 = W / 2 + sx[i] / z * K, y1 = H / 2 + sy[i] / z * K, x0 = W / 2 + sx[i] / z0 * K, y0 = H / 2 + sy[i] / z0 * K;
          if (x1 < -20 || x1 > W + 20 || y1 < -20 || y1 > H + 20) { sz[i] = 0; continue; }
          g.globalAlpha = clamp((1 - z) * 1.3, 0, 1) * clamp(a + .3, 0, 1); g.lineWidth = Math.max(1, W / 900 * (1.8 - z)); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        }
        g.restore();
      }
      // scroller with a wavy baseline
      if (wt(o, c, 'dText') > 0) {
        const txt = String(o.dText).trim() + '   *   ', px = Math.round(H * .07), font = `bold ${px}px ui-monospace,Menlo,Consolas,monospace`;
        g.save(); g.font = font; if (cwFont !== font) { cw = g.measureText('M').width; cwFont = font; }
        const tot = txt.length * cw, speed = (+o.dTextSpeed || 8) * cw, x0 = W - ((m * speed) % (tot + W)); g.textBaseline = 'middle'; g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = px * .25; g.shadowOffsetY = 2;
        for (let i = 0; i < txt.length; i++) {
          const x = x0 + i * cw; if (x < -cw || x > W) continue;
          g.fillStyle = `hsl(${(c.hue + i * 9 + m * 40) % 360},90%,64%)`; g.fillText(txt[i], x, H * .88 + Math.sin(m * 2.4 + i * .45) * px * .35 * (1 + kk * .8));
        }
        g.restore();
      }
      // glow: a blurred, brightened copy is added back (the soft, filmic look of the 64k intros)
      a = wt(o, c, 'dBloom');
      if (a > 0) {
        const w = Math.max(16, Math.round(W / 6)), h = Math.max(9, Math.round(H / 6)); bl1.width = w; bl1.height = h; bl2.width = w; bl2.height = h;
        try { b1.filter = 'contrast(1.6) brightness(.85)'; } catch (e) { /* older browsers: no filter */ }
        b1.drawImage(cv, 0, 0, w, h); b1.filter = 'none';
        try { b2.filter = `blur(${Math.max(1, w / 60)}px)`; } catch (e) { /* ignore */ }
        b2.drawImage(bl1, 0, 0); b2.filter = 'none';
        g.save(); g.imageSmoothingEnabled = true; g.globalCompositeOperation = 'lighter'; g.globalAlpha = clamp(a * (.45 + .4 * kk), 0, 1); g.drawImage(bl2, 0, 0, W, H); g.restore();
      }
      // film grain
      a = wt(o, c, 'dGrain');
      if (a > 0) {
        if (!grainPat) { const n = cnv(256, 256), nc = n.getContext('2d'), id = nc.createImageData(256, 256); for (let i = 0; i < id.data.length; i += 4) { const v = hash(i * .37 + seed) * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; } nc.putImageData(id, 0, 0); grainPat = g.createPattern(n, 'repeat'); }
        g.save(); g.translate(Math.floor(hash(m * 91.7) * 256), Math.floor(hash(m * 53.1 + 5) * 256)); g.globalCompositeOperation = 'overlay'; g.globalAlpha = clamp(a * .3, 0, .6); g.fillStyle = grainPat; g.fillRect(-256, -256, W + 512, H + 512); g.restore();
      }
      // old screen: scanlines and dark corners
      a = wt(o, c, 'dScan');
      if (a > 0) {
        if (!scanPat) { const p = cnv(1, Math.max(2, Math.round(H / 270))), pc = p.getContext('2d'); pc.fillStyle = 'rgba(0,0,0,.55)'; pc.fillRect(0, 0, 1, Math.max(1, p.height / 2)); scanPat = g.createPattern(p, 'repeat');
          vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .35, W / 2, H / 2, Math.hypot(W, H) * .55); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.75)'); }
        g.save(); g.globalAlpha = clamp(a * .6, 0, 1); g.fillStyle = scanPat; g.fillRect(0, 0, W, H); g.globalAlpha = clamp(a, 0, 1); g.fillStyle = vg; g.fillRect(0, 0, W, H); g.restore();
      }
      // flash on every new part of the song and on drops, the hard cut of a demo
      a = wt(o, c, 'dFlash');
      if (a > 0 && c.cut > .01) { g.save(); g.globalCompositeOperation = 'source-over'; g.globalAlpha = clamp(a * c.cut * .8, 0, .9); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.restore(); }
      // cinema bars
      a = wt(o, c, 'dBox');
      if (a > 0) { const bh = H * (.04 + .09 * a) * (1 + .1 * kk); g.fillStyle = '#000'; g.fillRect(0, 0, W, bh); g.fillRect(0, H - bh, W, bh); }
    }
    return { apply };
  }
  window.SPKDemo = { create, NAMES };
})();
