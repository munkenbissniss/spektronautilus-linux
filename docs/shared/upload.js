// Upload a finished video straight from the browser to YOUR OWN Vimeo account. Used by every app that makes a video.
//   SPK_UP.open(file, { title, description, name })
// Nothing goes through our servers: the file and the access token go only to Vimeo. The token is kept in this browser
// (the same place the Magic Mixer has always kept it).
(function () {
  'use strict';
  var VKEY = 'munken_vimeo';
  var T = function (s) { return window.SPK_T ? window.SPK_T(s) : s; };
  var rd = function (k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } };
  var wr = function (k, o) { try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) { /* private mode */ } };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var MB = function (n) { return (n / 1e6).toFixed(0); };
  var clean = function (s, n) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, n); };
  var fill = function (s, a) { return T(s).replace(/\{(\w)\}/g, function (m, k) { return a[k]; }); };

  // ------------------------------------------------------------------ Vimeo (tus resumable upload)
  async function vimeoUpload(file, o, token, say, ctl) {
    var H = { Authorization: 'bearer ' + token, Accept: 'application/vnd.vimeo.*+json;version=3.4' };
    var err = async function (r) { var t = ''; try { var e = await r.json(); t = e.developer_message || e.error || ''; } catch (x) { /* no body */ } return fill('Vimeo said {a}{b}', { a: r.status, b: t ? ': ' + t : '' }) + (r.status === 401 || r.status === 403 ? T('. Check that the token has the scopes upload, edit and private.') : ''); };
    say(T('Vimeo: creating the video…'));
    var r = await fetch('https://api.vimeo.com/me/videos', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H),
      body: JSON.stringify({ upload: { approach: 'tus', size: file.size }, name: clean(o.title, 128) || 'Spektronautilus', description: clean(o.description, 5000), privacy: { view: o.vprivacy } }) });
    if (!r.ok) { var fe = new Error(await err(r)); fe.fatal = true; throw fe; }
    var d = await r.json(), link = d.upload.upload_link, CH = 4 * 1024 * 1024, off = 0, tries = 0, t0 = Date.now(), pausedMs = 0;
    while (off < file.size) {
      if (ctl.stop) { var c = new Error('cancelled'); c.stop = true; throw c; }
      if (ctl.pause) {   // the upload is resumable, so it can simply wait between two pieces
        var pt = Date.now(); if (ctl.onPause) ctl.onPause(true);
        while (ctl.pause) { if (ctl.stop) { var c2 = new Error('cancelled'); c2.stop = true; throw c2; } say(fill('Paused at {a} % ({b} of {c} MB). Press Resume to carry on.', { a: Math.round(100 * off / file.size), b: MB(off), c: MB(file.size) })); await sleep(250); }
        pausedMs += Date.now() - pt; if (ctl.onPause) ctl.onPause(false);
      }
      var end = Math.min(file.size, off + CH);
      try {
        var p = await fetch(link, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(off), 'Content-Type': 'application/offset+octet-stream' }, body: file.slice(off, end) });
        if (!p.ok) throw new Error(fill('The upload failed ({a})', { a: p.status }));
        off = +p.headers.get('Upload-Offset') || end; tries = 0;
        var secs = (Date.now() - t0 - pausedMs) / 1000, left = secs > 6 && off > 0 ? Math.round(secs * (file.size - off) / off) : -1;
        say(fill('Vimeo: uploading {a} % ({b} of {c} MB)…', { a: Math.round(100 * off / file.size), b: MB(off), c: MB(file.size) }) + (left >= 0 ? ' ' + fill('About {a} left.', { a: Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') }) : ''), off / file.size);
      } catch (e) {
        if (++tries > 4) throw e;
        await sleep(2000 * tries);
        try { var h = await fetch(link, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } }); if (h.ok) off = +h.headers.get('Upload-Offset') || off; } catch (e2) { /* try again */ }
      }
    }
    return { link: d.link };
  }

  // ------------------------------------------------------------------ the dialog
  var css = '#spk-up{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:#000a;padding:12px;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '#spk-up .b{background:#fff;color:#14182b;border-radius:14px;width:min(520px,100%);max-height:100%;overflow:auto;padding:16px;box-sizing:border-box}' +
    '#spk-up *{box-sizing:border-box}#spk-up h2{margin:0 0 8px;font-size:1.15rem}#spk-up .m{color:#5a607a;font-size:.85rem}' +
    '#spk-up label{display:block;font-size:.88rem;margin:8px 0 2px}#spk-up input,#spk-up select,#spk-up textarea{width:100%;font:inherit;padding:6px 8px;border:1px solid #c9cde0;border-radius:8px;background:#f3f4f8;color:#14182b}' +
    '#spk-up textarea{min-height:56px}#spk-up button{font:inherit;cursor:pointer;border:2px solid #14182b;background:transparent;color:#14182b;padding:5px 14px;border-radius:999px;font-weight:600}' +
    '#spk-up button.main{background:#14182b;color:#fff}#spk-up button:disabled{opacity:.4;cursor:default}' +
    '#spk-up .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}#spk-up .bar{height:8px;background:#d5d8e6;border-radius:4px;overflow:hidden;margin-top:10px}#spk-up .bar.ind i{width:35%!important;background:repeating-linear-gradient(45deg,#4a56d8 0 10px,#8c94e8 10px 20px);animation:spkup 1.1s linear infinite}@keyframes spkup{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}'+
    '#spk-up .bar i{display:block;height:100%;width:0;background:#ff3d81}' +
    '#spk-up .st{margin-top:8px;overflow-wrap:anywhere}#spk-up .er{color:#d1334a}#spk-up .ok{color:#12906f}#spk-up a{color:#2b3af0}' +
    '@media (prefers-color-scheme:dark){#spk-up .b{background:#171a3a;color:#eceefb}#spk-up .m{color:#a0a6c8}#spk-up input,#spk-up select,#spk-up textarea{background:#10122a;color:#eceefb;border-color:#2a2e57}#spk-up button{border-color:#eceefb;color:#eceefb}#spk-up button.main{background:#eceefb;color:#10122a}#spk-up a{color:#7f8bff}#spk-up .bar{background:#2a2e57}}';
  var guideHref = function () { var l = window.SPK_LANG || 'en', p = location.pathname.replace(/\/(mixer|mixer-mobile|live-dj|live-mobile|vj-pad|vj-mobile|tools\/app|tools\/hospital|queue)\/.*$/, '/'); return p + (l !== 'en' ? l + '/' : '') + 'guides/tools/#upload'; };
  var cur = null, PRIV = { private: 'nobody', unlisted: 'unlisted', public: 'anybody' };

  function open(file, opt) {
    if (cur) return;
    opt = opt || {};
    if (!file || !file.size) { alert(T('There is no finished video to upload yet.')); return; }
    var v = rd(VKEY), busy = false, ctl = { stop: false };
    if (!document.getElementById('spk-up-css')) { var st = document.createElement('style'); st.id = 'spk-up-css'; st.textContent = css; document.head.appendChild(st); }
    var w = document.createElement('div'); w.id = 'spk-up'; w.setAttribute('role', 'dialog'); w.setAttribute('aria-modal', 'true'); w.setAttribute('aria-labelledby', 'spk-up-h'); cur = w;
    var title = opt.title || (opt.name || file.name || '').replace(/\.[^.]+$/, '');
    w.innerHTML = '<div class="b"><h2 id="spk-up-h">Upload to Vimeo</h2><div class="m" id="u-file"></div>' +
      '<label for="u-title">Title</label><input id="u-title" maxlength="128"><label for="u-desc">Description</label><textarea id="u-desc"></textarea>' +
      '<label for="u-priv">Who can watch</label><select id="u-priv"><option value="private">Only me (private)</option><option value="unlisted">Only with the link (unlisted)</option><option value="public">Everyone (public)</option></select>' +
      '<label for="u-vtok">Vimeo access token</label><input id="u-vtok" type="password" autocomplete="off" placeholder="Paste your personal Vimeo access token">' +
      '<p class="m">Your file and your token go only to Vimeo, never through Spektronautilus. <a id="u-guide" target="_blank" rel="noopener">How to set it up</a></p>' +
      '<div class="bar"><i id="u-bar"></i></div><div class="st" id="u-st" role="status" aria-live="polite"></div>' +
      '<div class="row"><button type="button" class="main" id="u-go">Upload</button><button type="button" id="u-pause" hidden>Pause</button><button type="button" id="u-stop" hidden>Stop</button><button type="button" id="u-close">Close</button></div></div>';
    document.body.appendChild(w);
    var $ = function (id) { return w.querySelector('#' + id); }, say = function (m, f) { $('u-st').className = 'st'; $('u-st').textContent = m; if (f != null) { $('u-bar').style.width = Math.round(f * 100) + '%'; $('u-bar').parentNode.classList.toggle('ind', f <= 0.002 && !ctl.pause); } };
    $('u-file').textContent = (opt.name || file.name || 'video') + ' · ' + MB(file.size) + ' MB';
    $('u-title').value = title; $('u-desc').value = opt.description || T('Made with Spektronautilus.');
    $('u-vtok').value = v.token || ''; $('u-guide').href = guideHref();
    $('u-priv').value = { nobody: 'private', unlisted: 'unlisted', anybody: 'public' }[v.privacy] || 'unlisted';
    function save() { v = { token: $('u-vtok').value.trim(), privacy: PRIV[$('u-priv').value], album: v.album }; wr(VKEY, v); }
    function close() { if (busy) return; document.removeEventListener('keydown', key); w.remove(); cur = null; }
    function key(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', key);
    $('u-close').onclick = close; w.addEventListener('click', function (e) { if (e.target === w) close(); });
    $('u-stop').onclick = function () { ctl.stop = true; };
    $('u-pause').onclick = function () { ctl.pause = !ctl.pause; $('u-pause').textContent = ctl.pause ? T('Resume') : T('Pause'); };
    $('u-go').onclick = async function () {
      save(); var o = { title: $('u-title').value, description: $('u-desc').value, vprivacy: PRIV[$('u-priv').value] }, token = $('u-vtok').value.trim();
      if (!token) { say(T('Paste your Vimeo access token first.')); $('u-st').className = 'st er'; return; }
      busy = true; ctl = { stop: false, pause: false }; $('u-pause').textContent = T('Pause'); $('u-pause').hidden = false; $('u-bar').parentNode.classList.add('ind'); $('u-go').disabled = true; $('u-close').disabled = true; $('u-stop').hidden = false; $('u-bar').style.width = '0';
      try {
        var r = await vimeoUpload(file, o, token, say, ctl);
        $('u-bar').parentNode.classList.remove('ind'); $('u-bar').style.width = '100%'; var m = $('u-st'); m.className = 'st ok'; m.textContent = T('Uploaded to Vimeo. Vimeo is now processing it, which can take a few minutes.') + ' ';
        var a = document.createElement('a'); a.href = r.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = T('Open on Vimeo'); m.appendChild(a);
      } catch (e) { say(e.stop ? T('Stopped.') : fill('The upload failed: {a}', { a: e.message || String(e) }) + ' ' + T('Press Upload to try again.')); if (!e.stop) $('u-st').className = 'st er'; }
      busy = false; $('u-go').disabled = false; $('u-close').disabled = false; $('u-stop').hidden = true; $('u-pause').hidden = true; $('u-bar').parentNode.classList.remove('ind');
    };
    $('u-title').focus();
  }
  window.SPK_UP = { open: open, _vimeo: vimeoUpload };
})();
