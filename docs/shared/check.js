// "Ready for the show?" – a quick check of the computer or phone and the browser before a live set. Nothing leaves the device.
// Apps can add rows with  window.SPK_CHECK_EXTRA = () => [{ name, state: 'ok'|'warn'|'bad'|'info', msg }].
(function () {
  var phone = !!document.querySelector('meta[name=spk-phone]') || /\/(live|vj)-mobile\//.test(location.pathname) || /mixer-mobile/.test(location.pathname);
  var T = function (s) { return (window.SPK_T || function (x) { return x; })(s); };
  var fill = function (s, a, b) { return s.replace('{a}', a).replace('{b}', b); };
  var LAST = [];

  function row(name, state, msg, a, b) { return { name: name, state: state, msg: msg, a: a, b: b }; }
  function framesPerSecond() {
    return new Promise(function (res) {
      var c = document.createElement('canvas'); c.width = 1280; c.height = 720; var x = c.getContext('2d'), src = document.createElement('canvas'); src.width = 640; src.height = 360;
      var sx = src.getContext('2d'), g = sx.createLinearGradient(0, 0, 640, 360); g.addColorStop(0, '#f0a'); g.addColorStop(1, '#0af'); sx.fillStyle = g; sx.fillRect(0, 0, 640, 360);
      var n = 0, t0 = 0, last = 0, ts = [];
      function f(t) {
        if (!t0) t0 = t; ts.push(t);
        x.globalCompositeOperation = 'source-over'; x.drawImage(src, 0, 0, 1280, 720); x.globalCompositeOperation = 'screen'; x.globalAlpha = .6;
        x.drawImage(src, (n * 7) % 200, 0, 1280, 720); x.globalAlpha = 1; x.filter = n % 2 ? 'none' : 'saturate(1.2)'; x.drawImage(c, 0, 0, 640, 360); x.filter = 'none'; n++;
        if (t - t0 < 700 && n < 120) requestAnimationFrame(f); else {
          var iv = ts.slice(1).map(function (v, i) { return v - ts[i]; }).sort(function (p, q) { return p - q; }), med = iv[Math.floor(iv.length / 2)] || 16.7;
          res({ fps: Math.round(1000 * (ts.length - 1) / (ts[ts.length - 1] - ts[0] || 1)), hz: Math.round(1000 / med) });
        }
      }
      if (document.hidden) return res(null);
      requestAnimationFrame(f);
    });
  }
  async function run() {
    var r = [], nav = navigator;
    var v = document.createElement('video');
    var h264 = !!(v.canPlayType && (v.canPlayType('video/mp4; codecs="avc1.42E01E"') || v.canPlayType('video/mp4')));
    r.push(h264 ? row('Video format', 'ok', 'This browser plays mp4 (H.264), the format the mixers like best.') : row('Video format', 'bad', "This browser can't play mp4 (H.264). Use Chrome, Edge or Safari, or convert your loops with the Tools."));
    var off = false; try { off = localStorage.getItem('spk_offline') === '1'; } catch (e) {}
    r.push(off ? row('Works without internet', 'ok', 'The site is saved in this browser and also works without internet.') : row('Works without internet', 'warn', 'Not saved for offline use yet. Open the site once with internet and wait a minute, then it also works without Wi-Fi at the venue.'));
    r.push('wakeLock' in nav ? row('Screen stays awake', 'ok', 'The screen can be kept awake during the show.') : row('Screen stays awake', 'warn', "This browser can't keep the screen awake. Turn off the screen saver and sleep in your system settings."));
    if (!phone) {
      var w = null; try { w = window.open('about:blank', 'spk_popup_test', 'popup,width=120,height=80'); } catch (e) {}
      if (w) { try { w.close(); } catch (e) {} r.push(row('Pop-up windows', 'ok', 'Pop-up windows are allowed (needed for the output window).')); }
      else r.push(row('Pop-up windows', 'bad', 'The browser blocked a pop-up. Allow pop-ups for this site, or the output window cannot open.'));
      if (typeof screen.isExtended === 'boolean') r.push(screen.isExtended ? row('Second screen', 'ok', 'A second screen is connected.') : row('Second screen', 'warn', 'Only one screen found. Connect the projector, then press “Run the check again”.'));
      else r.push(row('Second screen', 'info', 'This browser cannot tell if a second screen is connected. Open the output window and see.'));
    }
    r.push(document.fullscreenEnabled || document.webkitFullscreenEnabled ? row('Full screen', 'ok', 'Full screen is available.') : row('Full screen', 'warn', 'Full screen is not available in this browser.'));
    if (!phone) {
      if (!nav.requestMIDIAccess) r.push(row('MIDI controller', 'info', 'This browser has no MIDI. Use Chrome or Edge if you want to use a controller.'));
      else {
        var n = -1; try { var p = await nav.permissions.query({ name: 'midi' }); if (p.state === 'granted') { var a = await nav.requestMIDIAccess(); n = a.inputs.size; } } catch (e) {}
        if (n > 0) r.push(row('MIDI controller', 'ok', '{a} MIDI controller(s) connected.', n));
        else if (n === 0) r.push(row('MIDI controller', 'info', 'No MIDI controller found. That is fine if you use the mouse or touch.'));
        else r.push(row('MIDI controller', 'info', 'MIDI is not switched on yet. Press “Enable MIDI” if you use a controller.'));
      }
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    r.push(AC ? row('Sound', 'ok', 'Sound is ready.') : row('Sound', 'warn', 'Sound is not available in this browser.'));
    if (nav.getBattery) { try { var bt = await nav.getBattery(), pc = Math.round(bt.level * 100);
      r.push(bt.charging ? row('Battery', 'ok', 'Charging ({a} %).', pc) : pc < 30 ? row('Battery', 'warn', 'The battery is low ({a} %). Plug in before the show.', pc) : row('Battery', 'ok', 'Battery {a} %.', pc)); } catch (e) {} }
    var sp = await framesPerSecond();
    if (sp) { var want = Math.min(sp.hz, 60) * 0.8; r.push(sp.fps >= want ? row('Speed', 'ok', 'Smooth: about {a} frames per second on this screen ({b} Hz).', sp.fps, sp.hz) : row('Speed', 'warn', 'Slow: only about {a} frames per second. Close other tabs and programs, and use a smaller picture size.', sp.fps)); }
    if (nav.storage && nav.storage.estimate) { try { var es = await nav.storage.estimate(), gb = ((es.quota - es.usage) / 1e9); gb = gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
      r.push(gb >= 1 ? row('Free space', 'ok', '{a} GB free space in this browser.', gb) : row('Free space', 'warn', 'Little free space ({a} GB). Free up disk space before you record.', gb)); } catch (e) {} }
    if (window.SPK_CHECK_EXTRA) { try { r = r.concat(window.SPK_CHECK_EXTRA() || []); } catch (e) {} }
    return r;
  }

  // ---- interface
  var dlg, list, sum;
  var css = '#spk-chk{position:fixed;inset:0;z-index:99999;background:#000a;display:flex;align-items:center;justify-content:center;padding:12px;font:15px/1.4 system-ui,sans-serif}' +
    '#spk-chk .b{background:#14182b;color:#f4f5fb;border:1px solid #8886;border-radius:16px;max-width:560px;width:100%;max-height:92vh;overflow:auto;padding:18px 18px 14px;box-shadow:0 10px 40px #0009}' +
    '#spk-chk h2{margin:0 0 4px;font-size:20px}#spk-chk p{margin:0 0 10px;opacity:.8;font-size:14px}#spk-chk ul{list-style:none;margin:0;padding:0}' +
    '#spk-chk li{display:flex;gap:10px;padding:8px 0;border-top:1px solid #ffffff1c;align-items:flex-start}#spk-chk li i{flex:none;font-style:normal;font-weight:700;font-size:12px;border-radius:999px;padding:2px 8px;margin-top:1px;min-width:54px;text-align:center}' +
    '#spk-chk .ok i{background:#1f7a46;color:#fff}#spk-chk .warn i{background:#b97d00;color:#fff}#spk-chk .bad i{background:#b3263b;color:#fff}#spk-chk .info i{background:#3a4263;color:#fff}' +
    '#spk-chk li b{display:block;font-size:14px}#spk-chk li span{opacity:.85;font-size:13.5px}#spk-chk .sum{margin:10px 0;font-weight:700}' +
    '#spk-chk .bt{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}#spk-chk button{font:inherit;font-weight:600;border-radius:10px;border:1px solid #8886;background:#232a47;color:#fff;padding:9px 14px;min-height:42px;cursor:pointer}' +
    '#spk-chk button.p{background:#ff2d7a;border-color:#ff2d7a}#spk-chk button:focus-visible{outline:3px solid #fff;outline-offset:2px}' +
    '#spk-card{position:fixed;inset:0;z-index:100000;background:#000}#spk-card iframe{border:0;width:100%;height:100%}' +
    '#spk-chk-open{white-space:nowrap}@media print{#spk-chk,#spk-chk-open{display:none}}';
  var STATE = { ok: 'OK', warn: 'Check', bad: 'Problem', info: 'Info' };
  function render(rows) {
    LAST = rows; list.innerHTML = '';
    rows.forEach(function (x) {
      var li = document.createElement('li'); li.className = x.state;
      var i = document.createElement('i'); i.textContent = STATE[x.state] || ''; var d = document.createElement('div');
      var b = document.createElement('b'); b.textContent = x.name; var s = document.createElement('span'); s.textContent = x.a != null ? fill(x.msg, x.a, x.b) : x.msg;
      d.appendChild(b); d.appendChild(s); li.appendChild(i); li.appendChild(d); list.appendChild(li);
    });
    var bad = rows.filter(function (x) { return x.state === 'warn' || x.state === 'bad'; }).length;
    sum.textContent = bad ? '{a} thing(s) worth a look before you go on.'.replace('{a}', bad) : 'Everything looks good. Have a great show!';
    sum.style.color = bad ? '#ffcf5a' : '#6ee7a0';
  }
  function report() {
    var en = { ok: 'OK', warn: 'CHECK', bad: 'PROBLEM', info: 'INFO' };
    return ['Spektronautilus – ready-for-the-show report', location.href.split('?')[0], new Date().toISOString(), navigator.userAgent, screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1), ''].concat(
      LAST.map(function (x) { return '[' + en[x.state] + '] ' + x.name + ': ' + (x.a != null ? fill(x.msg, x.a, x.b) : x.msg); })).join('\n');
  }
  function testCard() {
    if (!phone) { var f = 'popup,width=960,height=540'; var w = null; try { w = window.open(base + 'testcard.html', 'spk_testcard', f); } catch (e) {} if (w) return; }
    var o = document.createElement('div'); o.id = 'spk-card'; var fr = document.createElement('iframe'); fr.src = base + 'testcard.html'; fr.title = 'Test card'; o.appendChild(fr); document.body.appendChild(o);
    var done = function () { o.remove(); removeEventListener('message', onm); }, onm = function (e) { if (e.data === 'spk-testcard-close') done(); }; addEventListener('message', onm);
    if (o.requestFullscreen) o.requestFullscreen().catch(function () {});
  }
  var base = (document.currentScript ? document.currentScript.src : location.href).replace(/[^/]*$/, '');
  function open() {
    if (dlg) return; dlg = document.createElement('div'); dlg.id = 'spk-chk'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'spk-chk-h');
    dlg.innerHTML = '<div class="b"><h2 id="spk-chk-h">Ready for the show?</h2><p>A quick check of this device and browser. Nothing is sent anywhere.</p><ul aria-live="polite"></ul><div class="sum"></div><div class="bt"></div></div>';
    list = dlg.querySelector('ul'); sum = dlg.querySelector('.sum'); var bt = dlg.querySelector('.bt');
    function btn(t, cls, fn) { var b = document.createElement('button'); b.type = 'button'; b.textContent = t; if (cls) b.className = cls; b.onclick = fn; bt.appendChild(b); return b; }
    var again = btn('Run the check again', 'p', go); btn('Show test card', '', testCard);
    var cp = btn('Copy report', '', function () { var t = report(); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { cp.textContent = T('Copied'); }, function () { var ta = document.createElement('textarea'); ta.value = t; dlg.appendChild(ta); ta.select(); try { document.execCommand('copy'); cp.textContent = T('Copied'); } catch (e) {} ta.remove(); }); });
    btn('Close', '', close);
    dlg.addEventListener('click', function (e) { if (e.target === dlg) close(); });
    document.addEventListener('keydown', onkey);
    document.body.appendChild(dlg); again.focus(); go();
    function go() { sum.textContent = 'Checking…'; sum.style.color = ''; run().then(render); }
  }
  function onkey(e) { if (e.key === 'Escape' && !document.getElementById('spk-card')) close(); }
  function close() { document.removeEventListener('keydown', onkey); if (dlg) { dlg.remove(); dlg = null; if (btnOpen) btnOpen.focus(); } }
  var btnOpen;
  function mount() {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var top = document.querySelector('.top'); if (!top) return;
    btnOpen = document.createElement('button'); btnOpen.type = 'button'; btnOpen.id = 'spk-chk-open'; btnOpen.className = 'sm'; btnOpen.textContent = 'Ready for the show?'; btnOpen.title = 'Check this device before you go live';
    btnOpen.onclick = open;
    var anchor = document.getElementById('openOut') || document.getElementById('fs'); if (anchor && anchor.parentNode === top) top.insertBefore(btnOpen, anchor); else top.appendChild(btnOpen);
  }
  window.SPK_CHECK = { open: open, run: run, report: report };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
