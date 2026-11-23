// The diagnostics log: what happened in the mixers, the tools and the Loop Hospital, kept in this browser on this device only.
// Nothing is ever sent anywhere. In the Feedback window you can download it (to attach to an email), clear it or switch it off.
//
// What it keeps: the device and browser (screen, cores, graphics card, video support), errors and warnings, video files that would
// not play, what was clicked and which settings were changed (never text you typed), how long jobs took and how they went, and a
// little about speed (slow moments, memory). Up to about 4000 entries; the oldest go first.
//
//   SPK_LOG.add(kind, data)    from the apps: a job started, finished, failed, a fallback, ...
//   SPK_LOG.text()             the whole log as text (a summary first, then one JSON line per entry)
//   SPK_LOG.download()  SPK_LOG.clear()  SPK_LOG.on  SPK_LOG.setOn(bool)  SPK_LOG.count()
(function () {
  if (window.SPK_LOG) return;
  var KEY = 'spk_log', ONKEY = 'spk_log_on', MAX = 4000, MAXCH = 1500000;
  var ls = function (f) { try { return f(window.localStorage); } catch (e) { return null; } };
  var on = ls(function (s) { return s.getItem(ONKEY); }) !== '0';
  var sid = Math.random().toString(36).slice(2, 8), t0 = Date.now(), mine = [], timer = 0, counts = {};
  var page = location.pathname.replace(/index\.html$/, '');
  var cut = function (s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
  var shortUrl = function (u) { u = String(u || ''); if (/^blob:/.test(u)) return 'blob'; if (/^data:/.test(u)) return 'data'; return cut(u.replace(location.origin, ''), 120); };
  function load() { var a = ls(function (s) { return JSON.parse(s.getItem(KEY) || '[]'); }); return Array.isArray(a) ? a : []; }
  function save() {
    timer = 0; if (!on) return;
    var others = load().filter(function (e) { return e.s !== sid; }), all = others.concat(mine);
    all.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
    if (all.length > MAX) all = all.slice(all.length - MAX);
    var txt = JSON.stringify(all);
    while (txt.length > MAXCH && all.length > 50) { all = all.slice(Math.ceil(all.length / 5)); txt = JSON.stringify(all); }
    var ok = ls(function (s) { s.setItem(KEY, txt); return true; });
    if (!ok) { all = all.slice(Math.ceil(all.length / 2)); ls(function (s) { s.setItem(KEY, JSON.stringify(all)); }); }   // storage full: keep the newer half
    var keep = {}; all.forEach(function (e) { if (e.s === sid) keep[e.t + e.k] = 1; }); mine = mine.filter(function (e) { return keep[e.t + e.k]; });
  }
  function later() { if (!timer) timer = setTimeout(save, 1500); }
  function add(kind, data) {
    if (!on) return;
    counts[kind] = (counts[kind] || 0) + 1;
    if (counts[kind] > (kind === 'click' || kind === 'set' ? 1500 : 400)) return;     // a runaway loop must not fill the log
    var e = { t: new Date().toISOString(), s: sid, p: page, k: kind };
    if (data !== undefined) e.d = data;
    mine.push(e); later();
  }
  function text() {
    save();
    var all = load(), by = {}, pages = {}, first = all[0], last = all[all.length - 1];
    all.forEach(function (e) { by[e.k] = (by[e.k] || 0) + 1; pages[e.p] = (pages[e.p] || 0) + 1; });
    var head = ['Spektronautilus diagnostics log', 'Made: ' + new Date().toISOString(), 'Entries: ' + all.length + (first ? ' (' + first.t + ' to ' + last.t + ')' : ''),
      'Pages: ' + Object.keys(pages).map(function (p) { return p + ' ' + pages[p]; }).join(', '), 'Kinds: ' + Object.keys(by).map(function (k) { return k + ' ' + by[k]; }).join(', '),
      'This browser: ' + navigator.userAgent, '', '--- one JSON line per entry ---'];
    return head.join('\n') + '\n' + all.map(function (e) { return JSON.stringify(e); }).join('\n') + '\n';
  }
  function download() {
    var b = new Blob([text()], { type: 'text/plain' }), u = URL.createObjectURL(b), a = document.createElement('a'), d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
    a.href = u; a.download = 'spektronautilus-log-' + stamp + '.txt'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
  }
  function clear() { mine = []; ls(function (s) { s.removeItem(KEY); }); }
  function setOn(v) { on = !!v; window.SPK_LOG.on = on; ls(function (s) { s.setItem(ONKEY, on ? '1' : '0'); }); if (!on) clear(); else add('log', { on: true }); }
  window.SPK_LOG = { add: add, text: text, download: download, clear: clear, setOn: setOn, on: on, count: function () { save(); return load().length; } };
  if (!on) return;

  // ---- the page and the device
  var gpu = function () {
    try {
      var c = document.createElement('canvas'), g = c.getContext('webgl2') || c.getContext('webgl'); if (!g) return 'no WebGL';
      var x = g.getExtension('WEBGL_debug_renderer_info'), r = x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
      var lose = g.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); return cut(r, 120);
    } catch (e) { return 'unknown'; }
  };
  var st = function () { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };
  add('page', { url: cut(location.pathname + location.search + location.hash, 160), ref: shortUrl(document.referrer), lang: document.documentElement.lang || '',
    screen: screen.width + 'x' + screen.height + '@' + (window.devicePixelRatio || 1), view: innerWidth + 'x' + innerHeight, cores: navigator.hardwareConcurrency || 0,
    mem: navigator.deviceMemory || 0, touch: navigator.maxTouchPoints || 0, app: st(), online: navigator.onLine, secure: window.isSecureContext,
    webcodecs: typeof VideoDecoder !== 'undefined', ua: cut(navigator.userAgent, 220) });
  var gpuDone = false; var addGpu = function () { if (gpuDone) return; gpuDone = true; add('gpu', { renderer: gpu() }); };
  if (document.readyState === 'complete') setTimeout(addGpu, 500); else addEventListener('load', function () { setTimeout(addGpu, 500); });

  // ---- errors and warnings
  addEventListener('error', function (e) {
    var el = e.target;
    if (el && el !== window && el.tagName) {   // a file that would not load or play
      var me = el.error; add('load-error', { el: el.tagName.toLowerCase(), src: shortUrl(el.currentSrc || el.src || el.href), code: me ? me.code : null, msg: me ? cut(me.message, 200) : '' });
      return;
    }
    add('error', { msg: cut(e.message, 300), at: shortUrl(e.filename) + ':' + e.lineno + ':' + e.colno, stack: cut(e.error && e.error.stack, 800) });
  }, true);
  addEventListener('unhandledrejection', function (e) { var r = e.reason; add('error', { msg: cut(r && r.message || r, 300), stack: cut(r && r.stack, 800), promise: true }); });
  ['error', 'warn'].forEach(function (lv) {
    var orig = console[lv]; if (!orig) return;
    console[lv] = function () {
      try { add('console', { lv: lv, msg: cut(Array.prototype.map.call(arguments, function (a) { return a && a.stack ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' '), 600) }); } catch (x) { /* ignore */ }
      return orig.apply(console, arguments);
    };
  });

  // ---- what was used: clicks and settings (never typed text)
  var label = function (el) {
    var id = el.id ? '#' + el.id : '', ds = []; for (var k in el.dataset || {}) ds.push(k + '=' + cut(el.dataset[k], 30));
    var txt = (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    return { el: el.tagName.toLowerCase() + id, txt: cut(txt, 50), ds: ds.length ? ds.join(' ') : undefined };
  };
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('button, a, [role=button], .tile, summary, label, input[type=checkbox], input[type=radio]');
    if (!el || (el.tagName === 'LABEL' && el.querySelector('input'))) return;      // a label with an input: the change below says it
    add('click', label(el));
  }, true);
  document.addEventListener('change', function (e) {
    var el = e.target; if (!el || !el.tagName) return;
    var tp = (el.type || '').toLowerCase(), d = label(el);
    if (tp === 'file') { var fs = Array.prototype.slice.call(el.files || []); d.files = fs.length; d.mb = Math.round(fs.reduce(function (a, f) { return a + f.size; }, 0) / 1e5) / 10; d.names = fs.slice(0, 10).map(function (f) { return cut(f.name, 60); }); delete d.txt; }
    else if (tp === 'text' || tp === 'email' || tp === 'search' || tp === 'password' || el.tagName === 'TEXTAREA') { d.len = String(el.value || '').length; delete d.txt; }
    else d.val = tp === 'checkbox' ? el.checked : cut(el.value, 60);
    if (el.name) d.name = el.name;
    add('set', d);
  }, true);

  // ---- videos that wait or stall, slow moments, memory, and leaving the page (counted, written once a minute)
  var media = { waiting: 0, stalled: 0 }, longs = { n: 0, max: 0 }, hiddenAt = 0;
  ['waiting', 'stalled'].forEach(function (ev) { document.addEventListener(ev, function () { media[ev]++; }, true); });
  try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (x) { longs.n++; if (x.duration > longs.max) longs.max = Math.round(x.duration); }); }).observe({ type: 'longtask', buffered: true }); } catch (e) { /* not in this browser */ }
  var tick = function (final) {
    var m = performance.memory, d = { up: Math.round((Date.now() - t0) / 1000) };
    if (media.waiting || media.stalled) { d.video = { waiting: media.waiting, stalled: media.stalled }; media.waiting = media.stalled = 0; }
    if (longs.n) { d.slow = { n: longs.n, maxMs: longs.max }; longs.n = 0; longs.max = 0; }
    if (m) d.memMB = Math.round(m.usedJSHeapSize / 1e6);
    if (final || d.video || d.slow) add(final ? 'leave' : 'perf', d);
  };
  setInterval(function () { tick(false); }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); add('hidden'); save(); }
    else if (hiddenAt) { add('visible', { awayS: Math.round((Date.now() - hiddenAt) / 1000) }); hiddenAt = 0; }
  });
  addEventListener('pagehide', function () { tick(true); save(); });
})();
