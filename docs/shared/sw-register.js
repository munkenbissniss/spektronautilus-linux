// Registers the offline service worker (not on localhost, where the Linux version and the tests run) and shows a small bar when a new version is waiting.
// A new version never replaces the old one by itself while the page is open, so a running show is never disturbed.
(function () {
  if (!('serviceWorker' in navigator)) return;
  var h = location.hostname, forced = /[?&]sw=1\b/.test(location.search);
  if (!forced && (h === 'localhost' || h === '127.0.0.1' || h === '[::1]')) return;
  var script = document.currentScript, swUrl = new URL('../sw.js', script ? script.src : location.href).href;
  var T = { en: ['A new version is ready.', 'Update now', 'Later'], no: ['En ny versjon er klar.', 'Oppdater nå', 'Senere'], es: ['Hay una versión nueva.', 'Actualizar', 'Luego'], de: ['Eine neue Version ist bereit.', 'Jetzt aktualisieren', 'Später'], pt: ['Uma nova versão está pronta.', 'Atualizar agora', 'Depois'] };
  var lang = (document.documentElement.lang || 'en').slice(0, 2), t = T[lang] || T.en;
  function bar(reg) {
    if (document.getElementById('spk-upd')) return;
    var d = document.createElement('div'); d.id = 'spk-upd'; d.setAttribute('role', 'status');
    d.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:99999;background:#14182b;color:#fff;padding:8px 10px 8px 16px;border-radius:999px;font:600 14px system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 4px 18px #0006;max-width:94vw';
    d.innerHTML = '<span></span><button style="font:inherit;border:0;border-radius:999px;padding:6px 14px;background:#ff6fa3;color:#14182b;cursor:pointer;min-height:32px"></button><button aria-label="x" style="font:inherit;border:0;background:transparent;color:#fff;cursor:pointer;opacity:.8;min-height:32px"></button>';
    var b = d.querySelectorAll('button'); d.firstChild.textContent = t[0]; b[0].textContent = t[1]; b[1].textContent = t[2];
    b[0].onclick = function () { if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); };
    b[1].onclick = function () { d.remove(); };
    document.body.appendChild(d);
  }
  var reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () { if (reloading || !window.__spkHadController) return; reloading = true; location.reload(); });
  window.__spkHadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register(swUrl).then(function (reg) {
    if (reg.waiting && navigator.serviceWorker.controller) bar(reg);
    reg.addEventListener('updatefound', function () {
      var w = reg.installing; if (!w) return;
      w.addEventListener('statechange', function () { if (w.state === 'installed' && navigator.serviceWorker.controller) bar(reg); });
    });
    navigator.serviceWorker.ready.then(function () { try { localStorage.setItem('spk_offline', '1'); } catch (e) {} window.dispatchEvent(new Event('spk-offline-ready')); });
    setInterval(function () { reg.update().catch(function () {}); }, 30 * 60 * 1000);
  }).catch(function () {});
})();
