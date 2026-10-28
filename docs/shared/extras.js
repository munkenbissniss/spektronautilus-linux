// Small helpers shared by the website and the apps:
//  - a "Guide" link that opens the manual for the tool you are using (apps only: <script src=".../extras.js" data-guide="video-dj">)
//  - a discreet "Feedback" button with a simple form. It opens your email program with the message filled in.
// Nothing is sent anywhere by this script. It has its own small word list so it works on every page, also offline.
(function () {
  var me = document.currentScript, guide = me && me.getAttribute('data-guide');
  var root = me ? new URL('../', me.src).href : location.origin + '/';       // the site root, from the script's own address
  var lang = 'en';
  try { lang = localStorage.getItem('spk_lang') || document.documentElement.lang || 'en'; } catch (e) { lang = document.documentElement.lang || 'en'; }
  lang = String(lang).slice(0, 2);
  var W = {
    en: { q: 'Queue', top: 'To the top', qfull: 'Open the full page', qclose: 'Close', guide: 'Guide', fb: 'Feedback', title: 'Send feedback', kind: 'What is this about?', k: ['An idea', 'Something is broken', 'A question', 'Just saying thanks'], msg: 'Your message', reply: 'Your email (optional, only if you want an answer)', info: 'Include the page and browser (helps to fix things)', send: 'Write the email', close: 'Close', hint: 'This opens your email program with the message filled in. Nothing is sent until you press send there.', fail: 'Nothing opened? Copy the message and send it to', copy: 'Copy message', copied: 'Copied', need: 'Write a message first.', subj: 'Spektronautilus feedback' },
    no: { q: 'Kø', top: 'Til toppen', qfull: 'Åpne hele siden', qclose: 'Lukk', guide: 'Guide', fb: 'Tilbakemelding', title: 'Send tilbakemelding', kind: 'Hva gjelder det?', k: ['En idé', 'Noe er ødelagt', 'Et spørsmål', 'Bare en takk'], msg: 'Meldingen din', reply: 'E-posten din (valgfritt, bare hvis du vil ha svar)', info: 'Ta med siden og nettleseren (hjelper meg å rette feil)', send: 'Skriv e-posten', close: 'Lukk', hint: 'Dette åpner e-postprogrammet ditt med meldingen ferdig utfylt. Ingenting sendes før du trykker send der.', fail: 'Åpnet ingenting? Kopier meldingen og send den til', copy: 'Kopier melding', copied: 'Kopiert', need: 'Skriv en melding først.', subj: 'Spektronautilus tilbakemelding' },
    es: { q: 'Cola', top: 'Ir arriba', qfull: 'Abrir la página completa', qclose: 'Cerrar', guide: 'Guía', fb: 'Comentarios', title: 'Enviar comentarios', kind: '¿De qué se trata?', k: ['Una idea', 'Algo no funciona', 'Una pregunta', 'Solo dar las gracias'], msg: 'Tu mensaje', reply: 'Tu correo (opcional, solo si quieres respuesta)', info: 'Incluir la página y el navegador (ayuda a corregir errores)', send: 'Escribir el correo', close: 'Cerrar', hint: 'Esto abre tu programa de correo con el mensaje ya escrito. No se envía nada hasta que pulses enviar allí.', fail: '¿No se abrió nada? Copia el mensaje y envíalo a', copy: 'Copiar mensaje', copied: 'Copiado', need: 'Escribe primero un mensaje.', subj: 'Comentarios sobre Spektronautilus' },
    de: { q: 'Warteschlange', top: 'Nach oben', qfull: 'Ganze Seite öffnen', qclose: 'Schließen', guide: 'Anleitung', fb: 'Feedback', title: 'Feedback senden', kind: 'Worum geht es?', k: ['Eine Idee', 'Etwas funktioniert nicht', 'Eine Frage', 'Nur ein Dankeschön'], msg: 'Deine Nachricht', reply: 'Deine E-Mail (optional, nur wenn du eine Antwort möchtest)', info: 'Seite und Browser mitsenden (hilft beim Beheben)', send: 'E-Mail schreiben', close: 'Schließen', hint: 'Das öffnet dein E-Mail-Programm mit der fertigen Nachricht. Erst wenn du dort auf Senden drückst, wird etwas verschickt.', fail: 'Nichts geöffnet? Kopiere die Nachricht und sende sie an', copy: 'Nachricht kopieren', copied: 'Kopiert', need: 'Schreibe zuerst eine Nachricht.', subj: 'Spektronautilus Feedback' },
    pt: { q: 'Fila', top: 'Para o topo', qfull: 'Abrir a página completa', qclose: 'Fechar', guide: 'Guia', fb: 'Comentários', title: 'Enviar comentários', kind: 'Sobre o que é?', k: ['Uma ideia', 'Algo não funciona', 'Uma pergunta', 'Só um agradecimento'], msg: 'A sua mensagem', reply: 'O seu e-mail (opcional, só se quiser resposta)', info: 'Incluir a página e o navegador (ajuda a corrigir)', send: 'Escrever o e-mail', close: 'Fechar', hint: 'Isto abre o seu programa de e-mail com a mensagem pronta. Nada é enviado até carregar em enviar lá.', fail: 'Não abriu nada? Copie a mensagem e envie para', copy: 'Copiar mensagem', copied: 'Copiado', need: 'Escreva primeiro uma mensagem.', subj: 'Comentários sobre o Spektronautilus' }
  };
  var t = W[lang] || W.en;
  var addr = ['oyvind.dahl', 'tutamail.com'].join('@');       // kept in two pieces so simple address collectors do not find it
  var GP = { en: '', no: 'no/', es: 'es/', de: 'de/', pt: 'pt/' };
  var css = document.createElement('style');
  css.textContent = '.spkx a,.spkx button{font:inherit}.spkx{display:inline-flex;gap:10px;align-items:center;font-size:.8rem;opacity:.75}.spkx:hover,.spkx:focus-within{opacity:1}' +
    '.spkx a,.spkx button{color:inherit;background:none;border:0;padding:2px 4px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;border-radius:6px}' +
    '.spkx-fix{position:fixed;left:8px;bottom:6px;z-index:9990;background:rgba(20,24,43,.82);color:#e8eaff;border-radius:999px;padding:3px 10px}' +
    '#spkx-m{position:fixed;inset:0;z-index:99995;background:rgba(8,10,24,.66);display:flex;align-items:center;justify-content:center;padding:14px}' +
    '#spkx-m .c{background:#171a3a;color:#eceefb;border:1px solid #2a2e57;border-radius:14px;max-width:460px;width:100%;max-height:92vh;overflow:auto;padding:18px 18px 14px;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left}' +
    '#spkx-m h2{margin:0 0 10px;font-size:1.15rem;color:#eceefb}#spkx-m label{display:block;margin:10px 0 3px;font-weight:600;font-size:.88rem}' +
    '#spkx-m select,#spkx-m textarea,#spkx-m input[type=email]{width:100%;font:inherit;color:#eceefb;background:#10122a;border:1px solid #3a3f78;border-radius:8px;padding:7px 9px}#spkx-m textarea{min-height:110px;resize:vertical}' +
    '#spkx-m .ck{display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:.85rem;margin-top:10px}#spkx-m .ck input{margin-top:3px}' +
    '#spkx-m .hint,#spkx-m .fail{font-size:.8rem;color:#a0a6c8;margin:10px 0 0}#spkx-m .fail{color:#eceefb}' +
    '#spkx-m .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}' +
    '#spkx-m .b{font:inherit;font-weight:700;border-radius:999px;padding:7px 16px;border:2px solid #eceefb;background:transparent;color:#eceefb;cursor:pointer}#spkx-m .b.go{background:#eceefb;color:#171a3a}' +
    '#spkx-m :focus-visible{outline:3px solid #ff6fa3;outline-offset:2px}' +
    '@media(max-width:600px){.spkx-fix .lbl{display:none}}';
  document.head.appendChild(css);

  function guideHref() { return root + GP[lang in GP ? lang : 'en'] + 'guides/' + guide + '/'; }

  // ---- the two small links
  var box = document.createElement('span'); box.className = 'spkx';
  if (guide) {
    var g = document.createElement('a'); g.href = guideHref(); g.target = '_blank'; g.rel = 'noopener';
    g.innerHTML = '📖 <span class="lbl"></span>'; g.lastChild.textContent = t.guide; box.appendChild(g);
  }
  var fb = document.createElement('button'); fb.type = 'button'; fb.innerHTML = '💬 <span class="lbl"></span>'; fb.lastChild.textContent = t.fb; fb.setAttribute('data-spk-feedback', ''); box.appendChild(fb);

  function mount() {
    var existing = document.querySelector('[data-spk-feedback-slot]');             // site pages put the button in the footer
    if (existing) { box.querySelectorAll('a').forEach(function (a) { a.remove(); }); existing.appendChild(box); return; }
    var back = document.querySelector('a.back, a[href="../"], a[href="../../"]');                                    // apps with a header link: sit next to it
    if (back && back.parentNode) { back.insertAdjacentElement('afterend', box); box.style.marginLeft = '10px'; return; }
    box.classList.add('spkx-fix'); document.body.appendChild(box);                  // otherwise a small floating pill in the corner
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // ---- the form
  var modal, lastFocus;
  function close() { if (modal) { modal.remove(); modal = null; } if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  function open() {
    if (modal) return;
    lastFocus = document.activeElement;
    modal = document.createElement('div'); modal.id = 'spkx-m';
    var opts = t.k.map(function (k, i) { return '<option value="' + i + '"></option>'; }).join('');
    modal.innerHTML = '<div class="c" role="dialog" aria-modal="true" aria-labelledby="spkx-t"><h2 id="spkx-t"></h2>' +
      '<label for="spkx-k"></label><select id="spkx-k">' + opts + '</select>' +
      '<label for="spkx-s"></label><textarea id="spkx-s" maxlength="1500"></textarea>' +
      '<label for="spkx-r"></label><input id="spkx-r" type="email" autocomplete="email">' +
      '<label class="ck"><input id="spkx-i" type="checkbox" checked><span></span></label>' +
      '<p class="hint"></p><p class="fail" hidden></p>' +
      '<div class="row"><button type="button" class="b" data-x="close"></button><button type="button" class="b go" data-x="send"></button></div></div>';
    var q = function (s) { return modal.querySelector(s); };
    q('h2').textContent = t.title; modal.querySelectorAll('label')[0].textContent = t.kind;
    modal.querySelectorAll('option').forEach(function (o, i) { o.textContent = t.k[i]; });
    modal.querySelectorAll('label')[1].textContent = t.msg; modal.querySelectorAll('label')[2].textContent = t.reply;
    q('.ck span').textContent = t.info; q('.hint').textContent = t.hint;
    q('[data-x=close]').textContent = t.close; q('[data-x=send]').textContent = t.send;
    // keys typed here must never reach the mixers (pads and shortcuts listen to the keyboard)
    ['keydown', 'keyup', 'keypress'].forEach(function (ev) { modal.addEventListener(ev, function (e) { if (ev === 'keydown' && e.key === 'Escape') { close(); } e.stopPropagation(); }); });
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    q('[data-x=close]').onclick = close;
    q('[data-x=send]').onclick = function () {
      var text = q('#spkx-s').value.trim(); if (!text) { q('#spkx-s').focus(); q('.hint').textContent = t.need; return; }
      var lines = [text, ''];
      var re = q('#spkx-r').value.trim(); if (re) lines.push('Reply to: ' + re);
      if (q('#spkx-i').checked) lines.push('Page: ' + location.href, 'Language: ' + lang, 'Screen: ' + screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1), 'Browser: ' + navigator.userAgent);
      var body = lines.join('\n'), subj = t.subj + ' – ' + q('#spkx-k').selectedOptions[0].textContent;
      var href = 'mailto:' + addr + '?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(body.slice(0, 1900));
      var fail = q('.fail'); fail.hidden = false; fail.textContent = '';
      fail.appendChild(document.createTextNode(t.fail + ' ' + addr + '  '));
      var cp = document.createElement('button'); cp.type = 'button'; cp.className = 'b'; cp.textContent = t.copy; cp.style.padding = '3px 12px';
      cp.onclick = function () { var full = subj + '\n\n' + body; (navigator.clipboard ? navigator.clipboard.writeText(full) : Promise.reject()).then(function () { cp.textContent = t.copied; }, function () { var ta = q('#spkx-s'); ta.focus(); ta.select(); }); };
      fail.appendChild(cp);
      var a = document.createElement('a'); a.href = href; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove();
    };
    document.body.appendChild(modal);
    q('#spkx-s').focus();
  }
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-spk-feedback]'); if (b) { e.preventDefault(); open(); } });
  window.SPK_FEEDBACK = open;

  // ---- bottom right: the job queue (opens as a panel, so it needs no page of its own) and a "to the top" button
  if (me && me.hasAttribute('data-dock')) {
    var dock = document.createElement('div'); dock.className = 'spkdock';
    var qb = document.createElement('button'); qb.type = 'button'; qb.setAttribute('aria-haspopup', 'dialog');
    qb.innerHTML = '📋 <span class="l"></span><span class="qn" hidden></span>'; qb.querySelector('.l').textContent = t.q;
    var up = document.createElement('button'); up.type = 'button'; up.className = 'up'; up.textContent = '↑'; up.title = up.ariaLabel = t.top;
    up.onclick = function () { window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth' }); };
    dock.appendChild(up); dock.appendChild(qb);
    var dcss = document.createElement('style');
    dcss.textContent = '.spkdock{position:fixed;right:10px;bottom:10px;z-index:9985;display:flex;gap:8px;align-items:center}.spkdock button{font:inherit;font-size:.82rem;cursor:pointer;color:#e8eaff;background:rgba(20,24,43,.88);border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:5px 12px;opacity:.8}.spkdock button:hover,.spkdock button:focus-visible{opacity:1}.spkdock .up{width:34px;height:34px;padding:0;font-size:1rem;display:none}.spkdock .up.on{display:block}.spkdock .qn{display:inline-block;margin-left:6px;min-width:1.3em;padding:0 6px;border-radius:999px;background:#ff6fa3;color:#14182b;font-size:.75em;font-weight:800;text-align:center}.spkdock .qn[hidden]{display:none}' +
      '#spkq{position:fixed;right:10px;bottom:56px;z-index:99990;width:min(460px,calc(100vw - 20px));height:min(72vh,580px);background:#171a3a;border:1px solid #2a2e57;border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden;font:14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#eceefb}#spkq[hidden]{display:none}' +
      '#spkq .h{display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid #2a2e57}#spkq .h b{flex:1}#spkq .h a,#spkq .h button{color:#eceefb;background:none;border:0;font:inherit;cursor:pointer;text-decoration:underline;padding:2px 4px}#spkq iframe{flex:1;border:0;width:100%;background:#10122a}';
    document.head.appendChild(dcss);
    var panel;
    function qupd() { try { var o = JSON.parse(localStorage.getItem('spk_q') || '{}'), n = Date.now() - (o.t || 0) < 30000 ? o.n || 0 : 0, b = qb.querySelector('.qn'); b.hidden = !n; b.textContent = n; } catch (e) {} }
    function qclose() { if (panel) { panel.hidden = true; qb.setAttribute('aria-expanded', 'false'); qb.focus(); } }
    qb.onclick = function () {
      var wasHidden = !panel || panel.hidden;
      if (!panel) {
        panel = document.createElement('div'); panel.id = 'spkq'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', t.q);
        panel.innerHTML = '<div class="h"><b></b><a target="_blank" rel="noopener"></a><button type="button"></button></div><iframe title=""></iframe>';
        panel.querySelector('b').textContent = t.q; var fa = panel.querySelector('a'); fa.textContent = t.qfull; fa.href = root + 'queue/';
        var cb = panel.querySelector('button'); cb.textContent = t.qclose; cb.onclick = qclose; panel.querySelector('iframe').title = t.q;
        document.body.appendChild(panel);
      }
      var open = wasHidden;
      panel.hidden = !open; qb.setAttribute('aria-expanded', open ? 'true' : 'false');
      var fr = panel.querySelector('iframe'); if (open && !fr.src) fr.src = root + 'queue/?embed=1';
    };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel && !panel.hidden) qclose(); });
    addEventListener('scroll', function () { up.classList.toggle('on', scrollY > 500); }, { passive: true });
    addEventListener('storage', qupd); setInterval(qupd, 4000); qupd();
    var mountDock = function () { document.body.appendChild(dock); }; if (document.body) mountDock(); else document.addEventListener('DOMContentLoaded', mountDock);
  }
})();
