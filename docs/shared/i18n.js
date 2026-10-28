// Translates the mixers and tools in the browser. The apps are written in English; this script swaps every piece of text that has an entry
// in the chosen language's dictionary (docs/shared/lang/<xx>.js, made by build_i18n.py), including text the apps write later (messages, status).
// Language: ?lang=xx, then the choice saved with the globe button, then the site language, then the browser language.
(function () {
  var LANGS = { en: 'English', no: 'Norsk', es: 'Español', de: 'Deutsch', pt: 'Português' };
  var script = document.currentScript, base = script ? script.src.replace(/[^/]*$/, '') : '';
  function pick() {
    var m = /[?&]lang=(\w\w)/.exec(location.search); if (m && LANGS[m[1]]) return m[1];
    try { var s = localStorage.getItem('spk_lang'); if (s && LANGS[s]) return s; } catch (e) {}
    var l = navigator.languages || [navigator.language || 'en'];
    for (var i = 0; i < l.length; i++) { var c = String(l[i]).slice(0, 2).toLowerCase(); if (c === 'nb' || c === 'nn') c = 'no'; if (LANGS[c]) return c; }
    return 'en';
  }
  var lang = window.SPK_LANG = pick(); window.SPK_LANGS = LANGS;
  document.documentElement.lang = lang;

  // ---- the language button
  function button() {
    if (!document.body || document.getElementById('spk-lang')) return;
    var w = document.createElement('div'); w.id = 'spk-lang'; w.setAttribute('data-no-i18n', '');
    w.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99998;font:600 13px system-ui,sans-serif';
    var b = document.createElement('button'); b.type = 'button'; b.textContent = '🌐 ' + lang.toUpperCase(); b.setAttribute('aria-label', 'Language'); b.setAttribute('aria-haspopup', 'true');
    b.style.cssText = 'border:1px solid #8886;border-radius:999px;background:#14182bcc;color:#fff;padding:5px 11px;cursor:pointer;min-height:32px;opacity:.75';
    var m = document.createElement('div'); m.hidden = true; m.style.cssText = 'position:absolute;left:0;bottom:38px;background:#14182b;border:1px solid #8886;border-radius:12px;padding:4px;min-width:130px;box-shadow:0 4px 18px #0006';
    Object.keys(LANGS).forEach(function (k) {
      var o = document.createElement('button'); o.type = 'button'; o.textContent = LANGS[k]; o.lang = k;
      o.style.cssText = 'display:block;width:100%;text-align:left;border:0;background:' + (k === lang ? '#ffffff22' : 'transparent') + ';color:#fff;padding:7px 10px;border-radius:8px;cursor:pointer;font:inherit;min-height:34px';
      o.onclick = function () { try { localStorage.setItem('spk_lang', k); } catch (e) {} location.reload(); };
      m.appendChild(o);
    });
    b.onclick = function () { m.hidden = !m.hidden; };
    document.addEventListener('click', function (e) { if (!w.contains(e.target)) m.hidden = true; });
    w.appendChild(b); w.appendChild(m); document.body.appendChild(w);
    var st = document.createElement('style'); st.textContent = ':fullscreen #spk-lang{display:none}@media print{#spk-lang{display:none}}'; document.head.appendChild(st);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', button); else button();
  if (lang === 'en') return;

  // ---- translating
  var exact = {}, pats = [], ready = false;
  var norm = function (s) { return s.replace(/\s+/g, ' ').trim(); };
  function build(d) {
    Object.keys(d).forEach(function (k) {
      if (k.indexOf('{') < 0) { exact[k] = d[k]; return; }
      var names = [], re = k.split(/(\{\w+\})/).map(function (p) {
        var m = /^\{(\w+)\}$/.exec(p); if (m) { names.push(m[1]); return '(.+?)'; }
        return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      pats.push({ re: new RegExp('^' + re + '$', 's'), names: names, to: d[k] });
    });
    pats.sort(function (a, b) { return b.re.source.length - a.re.source.length; });
  }
  function tr(s) {
    var n = norm(s); if (!n) return null;
    if (Object.prototype.hasOwnProperty.call(exact, n)) return exact[n];
    for (var i = 0; i < pats.length; i++) {
      var m = pats[i].re.exec(n); if (!m) continue;
      var vals = {}; pats[i].names.forEach(function (nm, j) { vals[nm] = tr(m[j + 1]) || m[j + 1]; });      // pieces like “Deck A” can be translated inside a sentence
      return pats[i].to.replace(/\{(\w+)\}/g, function (_, nm) { return vals[nm] != null ? vals[nm] : ''; });
    }
    return null;
  }
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, CODE: 0 };
  function skip(el) { return !el || SKIP[el.tagName] || (el.closest && el.closest('[data-no-i18n],[contenteditable]')); }
  function text(node) {
    if (skip(node.parentElement)) return;
    var v = node.nodeValue; if (node.__tr === v) return;
    var t = tr(v); if (t == null) return;
    var lead = /^\s*/.exec(v)[0], trail = /\s*$/.exec(v)[0]; node.__tr = lead + t + trail; node.nodeValue = node.__tr;
  }
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  function attrs(el) {
    if (skip(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], v = el.getAttribute && el.getAttribute(a); if (!v) continue;
      el.__tra = el.__tra || {}; if (el.__tra[a] === v) continue;
      var t = tr(v); if (t != null) { el.__tra[a] = t; el.setAttribute(a, t); }
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { text(root); return; }
    if (root.nodeType !== 1 || skip(root)) return;
    attrs(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    for (var n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) text(n); else if (!skip(n)) attrs(n); }
  }
  var busy = false;
  var mo = new MutationObserver(function (list) {
    if (!ready || busy) return; busy = true;
    try {
      list.forEach(function (m) {
        if (m.type === 'characterData') text(m.target);
        else if (m.type === 'attributes') attrs(m.target);
        else m.addedNodes.forEach(walk);
      });
    } finally { busy = false; }
    list = mo.takeRecords();
  });
  function start() {
    var d = window.SPK_DICT && window.SPK_DICT[lang]; if (!d) return;
    build(d); ready = true; walk(document.body); if (document.title) { var t = tr(document.title); if (t) document.title = t; }
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    window.SPK_T = function (s) { return tr(s) || s; };
  }
  var s = document.createElement('script'); s.src = base + 'lang/' + lang + '.js'; s.async = false;
  s.onload = function () { if (document.body) start(); else document.addEventListener('DOMContentLoaded', start); };
  document.head.appendChild(s);
  window.SPK_T = function (x) { return x; };
})();
