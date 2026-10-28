// Catalogue and loop-pack files: CSV, a self-contained web page, an info file and a contact sheet. No engine needed here.
export const LICENCES = [
  { id: 'cc0', label: 'CC0: public domain, anything goes', text: 'CC0 1.0 (public domain). You may use, change and share these loops for any purpose, with no credit needed.', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  { id: 'ccby', label: 'CC BY 4.0: free to use, credit the author', text: 'Creative Commons Attribution 4.0. You may use, change and share these loops, also commercially, as long as you credit the author.', url: 'https://creativecommons.org/licenses/by/4.0/' },
  { id: 'free', label: 'Free for personal and commercial use, no reselling of the loops', text: 'Free to use in your own shows, videos and projects, personal or commercial. You may not sell, share or give away the loops themselves, alone or in another pack.', url: '' },
  { id: 'personal', label: 'Personal use only', text: 'For personal, non-commercial use only. Contact the author for anything else.', url: '' },
  { id: 'custom', label: 'Custom (describe it in the notes)', text: 'See the notes below.', url: '' },
];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const slug = s => (String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/æ/gi, 'ae').replace(/ø/gi, 'o').replace(/å/gi, 'a').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()) || 'loop-pack';
export const loopWord = r => (r ? ({ seamless: 'loops', almost: 'almost', jump: 'jump' }[r.verdict] || '') : '');
const secs = d => (d >= 10 ? Math.round(d) : Math.round(d * 10) / 10);
const mb = b => Math.round(b / 1e5) / 10;
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

export function csv(rows) {
  const q = v => { v = String(v ?? ''); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = ['file', 'folder', 'width', 'height', 'fps', 'seconds', 'codec', 'size_mb', 'loop', 'loop_jump_ratio'];
  return '﻿' + [head.join(','), ...rows.map(r => [r.name, r.folder, r.info.width, r.info.height, Math.round(r.info.fps * 100) / 100, Math.round(r.info.duration * 100) / 100, r.info.codec, mb(r.size), loopWord(r.loop), r.loop ? Math.round(r.loop.ratio * 10) / 10 : ''].map(q).join(','))].join('\r\n') + '\r\n';
}

export function html(title, rows, meta = {}) {
  const lic = meta.licence ? LICENCES.find(l => l.id === meta.licence) : null;
  const total = rows.reduce((a, r) => a + r.size, 0);
  const tr = rows.map((r, i) => `<tr data-i="${i}"><td><img alt="" ${r.jpg ? `src="data:image/jpeg;base64,${b64(r.jpg)}"` : ''}></td><td data-v="${esc(r.name.toLowerCase())}"><b>${esc(r.name)}</b>${r.folder ? `<br><small>${esc(r.folder)}</small>` : ''}</td><td data-v="${r.info.duration}">${secs(r.info.duration)} s</td><td data-v="${r.info.width * r.info.height}">${r.info.width}×${r.info.height}</td><td data-v="${r.info.fps}">${Math.round(r.info.fps * 100) / 100}</td><td data-v="${esc(r.info.codec)}">${esc(r.info.codec)}</td><td data-v="${r.size}">${mb(r.size)} MB</td><td data-v="${r.loop ? r.loop.ratio : 99}" class="lp ${r.loop ? r.loop.verdict : ''}">${loopWord(r.loop) || '–'}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#fff;--ink:#14182b;--mute:#6b7194;--line:#d9dcec;--ok:#17803d;--bad:#b3263b;--a:#b97d00}@media(prefers-color-scheme:dark){:root{--bg:#10142a;--ink:#f1f2fb;--mute:#9aa0c8;--line:#2b3157;--ok:#58d98b;--bad:#ff7b8f;--a:#ffc857}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:20px 16px 40px}h1{margin:0 0 4px}.meta{color:var(--mute);margin:0 0 14px}
input[type=search]{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;width:100%;max-width:340px;margin:6px 0 12px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}th{cursor:pointer;user-select:none;white-space:nowrap;font-size:.85rem;color:var(--mute)}th:hover{color:var(--ink)}
td img{width:128px;height:72px;object-fit:cover;background:#000;border-radius:6px;display:block}small{color:var(--mute)}.lp.seamless{color:var(--ok);font-weight:700}.lp.almost{color:var(--a);font-weight:700}.lp.jump{color:var(--bad);font-weight:700}
@media(max-width:640px){td:nth-child(n+4):not(:last-child),th:nth-child(n+4):not(:last-child){display:none}td img{width:84px;height:48px}}</style></head><body><main>
<h1>${esc(title)}</h1><p class="meta">${rows.length} loops · ${mb(total)} MB${meta.author ? ' · by ' + esc(meta.author) : ''}${lic ? ' · ' + esc(lic.label) : ''}</p>
${meta.notes ? `<p>${esc(meta.notes)}</p>` : ''}<input type="search" id="q" placeholder="Search by name" aria-label="Search by name">
<table id="t"><thead><tr><th scope="col" aria-label="Preview"></th><th scope="col" data-k="1">Name</th><th scope="col" data-k="2">Length</th><th scope="col" data-k="3">Size</th><th scope="col" data-k="4">fps</th><th scope="col" data-k="5">Codec</th><th scope="col" data-k="6">File</th><th scope="col" data-k="7">Loop</th></tr></thead><tbody>${tr}</tbody></table>
<p class="meta">Made with Spektronautilus.</p></main>
<script>(function(){var t=document.getElementById('t'),b=t.tBodies[0],dir={};t.tHead.onclick=function(e){var h=e.target.closest('th[data-k]');if(!h)return;var k=+h.dataset.k;dir[k]=!dir[k];var rs=[].slice.call(b.rows);rs.sort(function(x,y){var a=x.cells[k].dataset.v,c=y.cells[k].dataset.v,n=+a,m=+c;var r=(!isNaN(n)&&!isNaN(m))?n-m:String(a).localeCompare(String(c));return dir[k]?r:-r});rs.forEach(function(r){b.appendChild(r)})};
document.getElementById('q').oninput=function(){var v=this.value.toLowerCase();[].forEach.call(b.rows,function(r){r.hidden=v&&r.cells[1].dataset.v.indexOf(v)<0})}})();</script></body></html>`;
}

export function readme(meta, rows) {
  const lic = LICENCES.find(l => l.id === meta.licence) || LICENCES[1], total = rows.reduce((a, r) => a + r.size, 0);
  const L = [meta.name, '='.repeat(Math.max(3, meta.name.length)), ''];
  if (meta.author) L.push('By: ' + meta.author);
  L.push(`${rows.length} loops, ${mb(total)} MB`, '', 'LICENCE', lic.label, lic.text + (lic.url ? '\n' + lic.url : ''), '');
  if (meta.notes) L.push('NOTES', meta.notes, '');
  L.push('FILES');
  rows.forEach(r => L.push(`- ${r.name}  (${secs(r.info.duration)} s, ${r.info.width}x${r.info.height}, ${Math.round(r.info.fps * 100) / 100} fps, ${mb(r.size)} MB${loopWord(r.loop) ? ', ' + (r.loop.verdict === 'seamless' ? 'seamless loop' : r.loop.verdict === 'almost' ? 'almost seamless' : 'loop point visible') : ''})`));
  L.push('', 'index.html is a catalogue you can open in any browser. contact-sheet.jpg shows every loop in one picture.', 'Made with Spektronautilus.', '');
  return L.join('\r\n');
}

export function packJson(meta, rows) {
  const lic = LICENCES.find(l => l.id === meta.licence) || LICENCES[1];
  return JSON.stringify({ name: meta.name, author: meta.author || '', licence: { id: lic.id, name: lic.label, text: lic.text, url: lic.url }, notes: meta.notes || '', created: new Date().toISOString(), generator: 'Spektronautilus',
    loops: rows.map(r => ({ file: r.name, seconds: Math.round(r.info.duration * 100) / 100, width: r.info.width, height: r.info.height, fps: Math.round(r.info.fps * 100) / 100, codec: r.info.codec, bytes: r.size, loop: r.loop ? r.loop.verdict : null })) }, null, 2) + '\n';
}

// one picture with every loop (needs a browser: it draws on a canvas)
export async function contactSheet(title, sub, rows) {
  const cols = rows.length <= 4 ? Math.max(1, rows.length) : rows.length <= 9 ? 3 : 4, tw = 320, th = 180, lab = 26, pad = 10, head = 74, n = rows.length, rws = Math.ceil(n / cols);
  const W = cols * (tw + pad) + pad, H = head + rws * (th + lab + pad) + pad, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  x.fillStyle = '#12162b'; x.fillRect(0, 0, W, H); x.fillStyle = '#fff'; x.textBaseline = 'alphabetic';
  x.font = '700 26px system-ui,sans-serif'; x.fillText(title, pad + 4, 34, W - 2 * pad); x.fillStyle = '#9aa0c8'; x.font = '15px system-ui,sans-serif'; x.fillText(sub, pad + 4, 58, W - 2 * pad);
  for (let i = 0; i < n; i++) {
    const cx = pad + (i % cols) * (tw + pad), cy = head + Math.floor(i / cols) * (th + lab + pad), r = rows[i];
    x.fillStyle = '#000'; x.fillRect(cx, cy, tw, th);
    if (r.jpg) { try { const bm = await createImageBitmap(new Blob([r.jpg], { type: 'image/jpeg' })), s = Math.min(tw / bm.width, th / bm.height); x.drawImage(bm, cx + (tw - bm.width * s) / 2, cy + (th - bm.height * s) / 2, bm.width * s, bm.height * s); bm.close && bm.close(); } catch (e) { /* no picture */ } }
    x.fillStyle = '#e8eaf8'; x.font = '13px system-ui,sans-serif'; x.fillText(r.name.length > 36 ? r.name.slice(0, 35) + '…' : r.name, cx, cy + th + 17, tw);
    if (r.loop) { x.font = '700 12px system-ui,sans-serif'; x.fillStyle = r.loop.verdict === 'seamless' ? '#58d98b' : r.loop.verdict === 'almost' ? '#ffc857' : '#ff7b8f'; const t = loopWord(r.loop); x.fillText(t, cx + tw - x.measureText(t).width, cy + th + 17); }
  }
  return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.88));
}
