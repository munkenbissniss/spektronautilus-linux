// Search free video sources from the browser (port of vjtools/search.py).
// Not every source allows a web page to download its files (CORS). When a download is blocked the app says so
// and offers the page link, so you can download the clip yourself and drop it into the Convert tab.

const B = () => ({
  pexels: 'https://api.pexels.com/videos/search', pixabay: 'https://pixabay.com/api/videos/',
  archive: 'https://archive.org', prelinger: 'https://archive.org', commons: 'https://commons.wikimedia.org/w/api.php',
  nasa: 'https://images-api.nasa.gov', ...(window.VJ_BASES || {}),
});
export const SOURCES = [
  { name: 'pexels', label: 'Pexels', needsKey: true },
  { name: 'pixabay', label: 'Pixabay', needsKey: true },
  { name: 'commons', label: 'Wikimedia Commons', needsKey: false },
  { name: 'nasa', label: 'NASA (space footage)', needsKey: false, def: false },
  { name: 'archive', label: 'Internet Archive (open licences)', needsKey: false },
  { name: 'prelinger', label: 'Prelinger Archives (vintage public-domain film)', needsKey: false },
  { name: 'commonsgif', label: 'Wikimedia GIF animations', needsKey: false },
  { name: 'archivegif', label: 'Internet Archive GIF animations', needsKey: false },
];
// government / military / NASA footage floods the old-film sources. It is hidden unless you turn the filter off (NASA itself is never hidden when you pick it).
export const GOV = /\b(department of defen[cs]e|dept\.? of defen[cs]e|dod|u\.? ?s\.? ?(army|navy|air ?force|marines?|coast guard|government|gov|information agency|signal corps)|united states (army|navy|air ?force|marine|government|information agency|department|national archives)|armed forces|nasa|national aeronautics|pentagon|military|signal corps|usaf|public information office|national archives|usgov|usarmy|usnavy|airforce)\b/i;
export const isGov = r => r.provider !== 'nasa' && GOV.test(r.meta || '');
const LOOPY = /\b(loop(s|ed|ing|able)?|seamless|vj)\b/i;
const meta = (...a) => a.flat().filter(Boolean).join(' ');
function parseRuntime(v) {
  v = Array.isArray(v) ? v[0] : v; if (!v) return 0; v = String(v);
  let m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(v.trim()); if (m) return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  let t = 0, f = false; for (const [re, k] of [[/(\d+(?:\.\d+)?)\s*h(?:ou)?rs?/i, 3600], [/(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\b/i, 60], [/(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b/i, 1]]) { m = re.exec(v); if (m) { t += +m[1] * k; f = true; } }
  return f ? t : 0;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { /* keep the item */ } } })); }
const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
export const getKey = n => store.get('vj_key_' + n);
export const setKey = (n, v) => store.set('vj_key_' + n, (v || '').trim());
export const status = () => SOURCES.map(s => ({ ...s, ready: !s.needsKey || !!getKey(s.name) }));
export const defaultSources = () => status().filter(s => s.ready && s.def !== false).map(s => s.name);

const strip = s => { const d = document.createElement('div'); d.innerHTML = String(s || '').replace(/<[^>]+>/g, ''); return d.textContent.trim(); };
async function getJson(url, headers) {
  let r;
  try { r = await fetch(url, { headers }); } catch (e) { throw new Error(`${new URL(url).host}: the browser could not reach it (blocked or offline)`); }
  if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  return r.json();
}
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
const licName = u => { const m = /creativecommons\.org\/(licenses|publicdomain)\/([a-z\-]+)\/?([\d.]*)/.exec(u || ''); if (!m) return 'Open licence'; return m[1] === 'licenses' ? 'CC ' + m[2].toUpperCase() + (m[3] ? ' ' + m[3] : '') : 'Public domain (' + m[2].toUpperCase() + ')'; };

const P = {
  async pexels(q, n, page, o) {
    const key = getKey('pexels'); if (!key) throw new Error('Pexels needs a free API key');
    const j = await getJson(`${B().pexels}?${qs({ query: q, per_page: Math.min(n, 80), page, orientation: o.orientation })}`, { Authorization: key });
    const out = [];
    for (const v of j.videos || []) {
      const files = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && f.link); if (!files.length) continue;
      const cap = o.maxHeight || 1080, ok = files.filter(f => (f.height || 0) <= cap), best = (ok.length ? ok : files).reduce((a, b) => (b.height || 0) > (a.height || 0) ? b : a);
      const slug = (v.url || '').replace(/\/$/, '').split('/').pop().replace(/-\d+$/, '').replace(/-/g, ' ');
      out.push({ provider: 'pexels', kind: 'video', loops: LOOPY.test(slug), meta: slug, id: String(v.id), title: `Pexels video ${v.id} ${slug}`.trim(), page: v.url || '', thumb: v.image || '', url: best.link, width: best.width || 0, height: best.height || 0, duration: +v.duration || 0, author: v.user?.name || '', license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/' });
    }
    return out;
  },
  async pixabay(q, n, page, o) {
    const key = getKey('pixabay'); if (!key) throw new Error('Pixabay needs a free API key');
    const j = await getJson(`${B().pixabay}?${qs({ key, q, per_page: Math.max(3, Math.min(n, 200)), page, safesearch: 'true', video_type: ['film', 'animation'].includes(o.pixabayType) ? o.pixabayType : '' })}`);
    const out = [];
    for (const h of j.hits || []) {
      const vs = h.videos || {}, cands = ['large', 'medium', 'small', 'tiny'].map(k => vs[k]).filter(c => c && c.url), cap = o.maxHeight || 1080;
      if (!cands.length) continue;
      const ok = cands.filter(c => (c.height || 0) <= cap), best = (ok.length ? ok : cands).reduce((a, b) => (b.height || 0) > (a.height || 0) ? b : a);
      out.push({ provider: 'pixabay', kind: 'video', loops: LOOPY.test(h.tags || ''), meta: h.tags || '', id: String(h.id), title: (h.tags || 'Pixabay video').replace(/,/g, ' ·'), page: h.pageURL || '', thumb: h.picture_id ? `https://i.vimeocdn.com/video/${h.picture_id}_640x360.jpg` : '', url: best.url, width: best.width || 0, height: best.height || 0, duration: +h.duration || 0, author: h.user || '', license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/' });
    }
    return out;
  },
  async archive(q, n, page, o, name = 'archive') {
    const gif = name === 'archivegif', pre = name === 'prelinger', base = B()[pre ? 'prelinger' : 'archive'];
    const lic = '(licenseurl:*creativecommons* OR licenseurl:*publicdomain*)';
    const clause = pre ? 'mediatype:movies AND collection:prelinger' : gif ? `mediatype:image AND format:"Animated GIF" AND ${lic}` : `mediatype:movies AND ${lic}`;
    const filtering = !gif && (o.hideGov || o.maxSeconds || o.minSeconds), rows = Math.min(100, n * (filtering ? 3 : 1));
    const u = new URLSearchParams([['q', `(${q}) AND ${clause}`], ['rows', rows], ['page', page], ['output', 'json'], ['sort[]', 'downloads desc'], ...['identifier', 'title', 'creator', 'licenseurl', 'subject', 'collection', 'runtime'].map(f => ['fl[]', f])]);
    const j = await getJson(`${base}/advancedsearch.php?${u}`);
    let out = (j.response?.docs || []).map(d => ({ provider: name, kind: gif ? 'gif' : 'video', loops: gif || LOOPY.test(meta(d.title, d.subject)), meta: meta(d.title, d.creator, d.subject, d.collection), id: d.identifier, title: strip(d.title || d.identifier), page: `${base}/details/${d.identifier}`, thumb: `${base}/services/img/${d.identifier}`, url: '', width: 0, height: 0,
      duration: parseRuntime(d.runtime), author: Array.isArray(d.creator) ? d.creator.join(', ') : (d.creator || ''), license: pre ? 'Public domain (Prelinger Archives)' : 'Open licence (see page)', licenseUrl: pre ? 'https://archive.org/details/prelinger' : (typeof d.licenseurl === 'string' ? d.licenseurl : '') }));
    const cut = f => { const k = out.filter(f); if (o.hid) o.hid.n += out.length - k.length; out = k; };
    if (o.hideGov) cut(r => !isGov(r));
    if (o.maxSeconds) cut(r => !(r.duration && r.duration > o.maxSeconds));
    out = out.slice(0, n * 2);
    // the search answer has no reliable length, so ask each item for its files (also checks there is a video at all)
    if (!gif && (o.maxSeconds || o.minSeconds)) {
      await pool(out, 6, async r => { await resolveArchive(r, true); });
      cut(r => !r.noFile && !(o.maxSeconds && r.duration && r.duration > o.maxSeconds) && !(o.minSeconds && r.duration && r.duration < o.minSeconds));
    }
    return out.slice(0, n);
  },
  prelinger(q, n, page, o) { return this.archive(q, n, page, o, 'prelinger'); },
  archivegif(q, n, page, o) { return this.archive(q, n, page, o, 'archivegif'); },
  async nasa(q, n, page) {
    const j = await getJson(`${B().nasa}/search?${qs({ q, media_type: 'video', page, page_size: Math.min(n, 100) })}`);
    return (j.collection?.items || []).filter(it => it.data?.[0]?.nasa_id).map(it => {
      const d = it.data[0], thumb = (it.links || []).find(l => l.render === 'image')?.href || '';
      return { provider: 'nasa', kind: 'video', loops: false, meta: '', id: d.nasa_id, title: strip(d.title || d.nasa_id), page: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`, thumb: thumb.replace('http://', 'https://'), url: '', width: 0, height: 0, duration: 0, author: d.secondary_creator || d.photographer || (d.center ? 'NASA ' + d.center : 'NASA'), license: 'NASA media (public domain unless marked)', licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/' };
    });
  },
  async commons(q, n, page, o, name = 'commons') {
    const gif = name === 'commonsgif';
    const lim = Math.min(n, 50);
    const j = await getJson(`${B().commons}?${qs({ action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: 6, gsrsearch: gif ? `filetype:bitmap filemime:gif ${q}` : `filetype:video ${q}`, gsrlimit: lim, gsroffset: (page - 1) * lim, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata|mediatype', iiurlwidth: 640 })}`);
    const pages = Object.values(j.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0)), out = [];
    for (const p of pages) {
      const ii = (p.imageinfo || [{}])[0]; if (!ii.url || (gif && ii.mime !== 'image/gif')) continue; const md = ii.extmetadata || {};
      out.push({ provider: name, kind: gif ? 'gif' : 'video', loops: gif || LOOPY.test(p.title || ''), meta: meta(p.title, strip(md.Artist?.value), strip(md.Categories?.value), strip(md.ImageDescription?.value)), id: String(p.pageid), title: (p.title || '').replace(/^File:/, '').replace(/\.[^.]+$/, ''), page: ii.descriptionurl || '', thumb: ii.thumburl || '', url: ii.url, width: ii.width || 0, height: ii.height || 0, duration: +ii.duration || 0, author: strip(md.Artist?.value), license: md.LicenseShortName?.value || '', licenseUrl: md.LicenseUrl?.value || '' });
    }
    return out;
  },
  commonsgif(q, n, page, o) { return this.commons(q, n, page, o, 'commonsgif'); },
};

export async function search(query, sources, { perSource = 12, page = 1, loopWord = true, minHeight = 0, minSeconds = 0, maxSeconds = 0, orientation = '', pixabayType = '', hideGov = true, loopsFirst = true } = {}) {
  const results = [], errors = {}, hid = { n: 0 };
  await Promise.all(sources.map(async name => {
    const qq = query.trim() + (loopWord && ['pexels', 'pixabay', 'commons'].includes(name) && !/loop/i.test(query) ? ' loop' : '');
    try { (await P[name](qq, perSource, page, { orientation, maxHeight: 1080, pixabayType, hideGov, minSeconds, maxSeconds, hid })).forEach(r => results.push(r)); }
    catch (e) { errors[name] = e.message; }
  }));
  const order = sources.reduce((m, s, i) => (m[s] = i, m), {});
  let hidden = hid.n;
  const keep = results.filter(r => {
    const bad = (minHeight && r.height && r.height < minHeight) || (minSeconds && r.duration && r.duration < minSeconds) || (maxSeconds && r.duration && r.duration > maxSeconds) || (hideGov && isGov(r));
    if (bad) hidden++; return !bad;
  });
  keep.sort((a, b) => (loopsFirst ? (b.loops ? 1 : 0) - (a.loops ? 1 : 0) : 0) || order[a.provider] - order[b.provider]);
  return { results: keep, errors, hidden };
}

// find the real file of an Internet Archive item
async function resolveArchive(r, quiet = false) {
  const base = B()[r.provider === 'prelinger' ? 'prelinger' : 'archive'], gif = r.provider === 'archivegif';
  let j;
  if (quiet) { const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000); try { const x = await fetch(`${base}/metadata/${r.id}`, { signal: ac.signal }); if (!x.ok) return r; j = await x.json(); } catch (e) { return r; } finally { clearTimeout(t); } }
  else j = await getJson(`${base}/metadata/${r.id}`);
  const files = (j.files || []).filter(f => (gif ? /\.gif$/i.test(f.name || '') : /\.(mp4|webm|ogv|mov|m4v|mkv)$/i.test(f.name || '')) && ['original', 'derivative'].includes(f.source));
  if (!files.length) { if (quiet) { r.noFile = true; return r; } throw new Error(gif ? 'No GIF file in this archive item' : 'No video file in this archive item'); }
  const pri = f => /\.mp4$/i.test(f.name) ? 0 : /\.webm$/i.test(f.name) ? 1 : 2, sz = f => (+f.size > 0 ? +f.size : 1e18);
  files.sort((a, b) => pri(a) - pri(b) || sz(a) - sz(b));
  r.url = `${base}/download/${r.id}/${encodeURIComponent(files[0].name)}`;
  const len = parseFloat(files[0].length); if (len > 0) r.duration = len;
  const w = +files[0].width, h = +files[0].height; if (w > 0 && h > 0) { r.width = w; r.height = h; }
  const lic = j.metadata?.licenseurl; if (typeof lic === 'string') { r.licenseUrl = lic; r.license = licName(lic); }
  return r;
}

// download one result -> File. Throws a friendly error when the site does not allow it from a web page.
async function resolveNasa(r) {
  const j = await getJson(`${B().nasa}/asset/${encodeURIComponent(r.id)}`);
  const mp4 = (j.collection?.items || []).map(i => i.href || '').filter(h => /\.mp4$/i.test(h));
  if (!mp4.length) throw new Error('No mp4 file for this NASA item');
  const hit = ['~large', '~medium', '~orig', '~small', '~mobile'].map(t => mp4.find(h => h.includes(t))).find(Boolean) || mp4[0];
  r.url = B().nasa.startsWith('https') ? hit.replace('http://', 'https://') : hit;
  return r;
}

export async function download(r, onProgress, signal) {
  if (!r.url && (r.provider === 'archive' || r.provider === 'prelinger' || r.provider === 'archivegif')) { const l = [r.license, r.licenseUrl]; await resolveArchive(r); if (r.provider === 'prelinger') [r.license, r.licenseUrl] = [l[0], l[1] || 'https://archive.org/details/prelinger']; }
  if (!r.url && r.provider === 'nasa') await resolveNasa(r);
  if (!r.url) throw new Error('No download link');
  let resp;
  try { resp = await fetch(r.url, { signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new Error('This site does not let a web page download its files. Use "Open page", download the clip yourself and drop it into the Convert tab.'); }
  if (!resp.ok) throw new Error(`Download failed (HTTP ${resp.status})`);
  const total = +resp.headers.get('Content-Length') || 0, chunks = []; let got = 0;
  const rd = resp.body.getReader();
  for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length; if (total && onProgress) onProgress(got / total); if (got > 1.5e9) throw new Error('File is too large for the browser'); }
  const ext = (/\.(mp4|webm|mov|mkv|ogv|m4v|gif)(\?|$)/i.exec(r.url) || [, 'mp4'])[1].toLowerCase();
  return new File(chunks, `${r.provider}_${String(r.id).replace(/[^\w.\-]+/g, '_').slice(0, 60)}.${ext}`, { type: resp.headers.get('Content-Type') || '' });
}

export function creditsCsv(rows) {
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  return ['file,title,author,licence,licence_url,source_page,downloaded', ...rows.map(r => r.map(q).join(','))].join('\n') + '\n';
}
