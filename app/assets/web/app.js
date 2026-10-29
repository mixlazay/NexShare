/* NexShare web desktop: DSM-style UI for browsing and sharing the phone's files. */
'use strict';

// ---------------------------------------------------------------- helpers

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

// Like node.replaceChildren but drops null/false/undefined args (which would otherwise
// be inserted as the literal text "null"/"false").
function fill(node, ...kids) {
  node.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('ns.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ns.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(one));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

async function api(path, params, opt = {}) {
  const r = await fetch('/api/' + path + qs(params), {
    method: opt.method || 'GET',
    body: opt.body,
    headers: opt.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
  });
  let j = {};
  try { j = await r.json(); } catch { /* empty body */ }
  if (r.status === 401 && path !== 'login') { Auth.show(); throw Object.assign(new Error('unauthorized'), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { status: r.status });
  return j;
}

const fileUrl = (p, dl) => '/api/file' + qs({ path: p, dl: dl ? 1 : null });
const thumbUrl = (p, s = 240) => '/api/thumb' + qs({ path: p, s });

function fmtSize(n) {
  if (n == null || n < 0) return '-';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
const fmtRate = n => fmtSize(Math.max(0, n)).replace(' B', ' B') + '/s';
function fmtDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtUptime(ms) {
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  return (d ? d + ' วัน ' : '') + h + ' ชม. ' + m + ' นาที';
}
const extOf = n => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };

const KIND = {};
for (const [k, list] of Object.entries({
  image: 'jpg jpeg png gif webp bmp heic heif svg',
  video: 'mp4 m4v webm mkv 3gp mov avi',
  audio: 'mp3 m4a aac ogg opus wav flac amr',
  pdf: 'pdf',
  text: 'txt log md csv json xml html htm css js ini conf yml yaml srt',
  archive: 'zip rar 7z tar gz bz2 xz',
  apk: 'apk xapk apks',
  doc: 'doc docx odt rtf',
  sheet: 'xls xlsx ods',
  slide: 'ppt pptx odp',
})) for (const e of list.split(' ')) KIND[e] = k;
const kindOf = entry => entry.dir ? 'folder' : (KIND[extOf(entry.name)] || 'file');
const KIND_LABEL = { folder: 'โฟลเดอร์', image: 'รูปภาพ', video: 'วิดีโอ', audio: 'เสียง', pdf: 'PDF', text: 'ข้อความ', archive: 'ไฟล์บีบอัด', apk: 'แอป Android', doc: 'เอกสาร', sheet: 'สเปรดชีต', slide: 'งานนำเสนอ', file: 'ไฟล์' };

function toast(msg, ms = 2600) {
  const t = el('div', { class: 'toast', text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

function dialog({ title, message, input, okText = 'ตกลง', danger, cancel = true }) {
  return new Promise(resolve => {
    const field = input != null ? el('input', { value: input, spellcheck: 'false' }) : null;
    const close = v => { wrap.remove(); resolve(v); };
    const ok = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), text: okText, onclick: () => close(field ? field.value : true) });
    const wrap = el('div', { id: 'modal', onmousedown: e => { if (e.target === wrap && cancel) close(null); } },
      el('div', { class: 'dialog' },
        el('div', { class: 'd-head', text: title }),
        el('div', { class: 'd-body' }, message ? el('div', { text: message, style: { marginBottom: field ? '10px' : 0 } }) : null, field),
        el('div', { class: 'd-foot' }, cancel ? el('button', { class: 'btn', text: 'ยกเลิก', onclick: () => close(null) }) : null, ok)));
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
      if (e.key === 'Escape' && cancel) close(null);
    });
    document.body.append(wrap);
    if (field) {
      field.focus();
      const dot = field.value.lastIndexOf('.');
      field.setSelectionRange(0, dot > 0 ? dot : field.value.length);
    } else ok.focus();
  });
}

let openMenuEl = null;
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }
function menu(items, x, y) {
  closeMenu();
  const m = el('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(el('hr')); continue; }
    m.append(el('button', {
      class: it.danger ? 'danger' : null, disabled: it.disabled,
      onclick: () => { closeMenu(); it.run(); },
    }, it.ico ? icon(it.ico) : null, it.label));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
  openMenuEl = m;
}
function menuAt(btn, items) { const r = btn.getBoundingClientRect(); menu(items, r.left, r.bottom + 4); }

let openPop = null;
function closePop() { if (openPop) { openPop.el.remove(); openPop.btn && openPop.btn.classList.remove('active'); openPop = null; } }
document.addEventListener('mousedown', e => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
  if (openPop && !openPop.el.contains(e.target) && !(openPop.btn && openPop.btn.contains(e.target))) closePop();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); closePop(); } });

// ---------------------------------------------------------------- icons

const G = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  fwd: '<path d="M9 18l6-6-6-6"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  newfolder: '<path d="M3 6h6l2 2h10v11H3z"/><path d="M12 11v6M9 14h6"/>',
  rename: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  cut: '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8 16L19 4M16 16L5 4"/>',
  paste: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2"/>',
  zip: '<path d="M6 3h9l4 4v14H6z"/><path d="M11 6h2M11 9h2M11 12h2M10 15h4v3h-4z"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  caret: '<path d="M9 6l6 6-6 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  min: '<path d="M5 12h14"/>',
  max: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  restore: '<rect x="4" y="8" width="12" height="12" rx="2"/><path d="M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8v.01M12 11v5"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  folderUp: '<path d="M3 6h6l2 2h10v11H3z"/><path d="M12 17v-6M9 14l3-3 3 3"/>',
};
function icon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = G[name] || '';
  return s;
}

// App icons, 64x64.
const APP_ICO = {
  filestation: `<svg viewBox="0 0 64 64"><defs><linearGradient id="fsA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd76a"/><stop offset="1" stop-color="#f5a623"/></linearGradient></defs>
    <path d="M6 16a4 4 0 0 1 4-4h14l5 5h25a4 4 0 0 1 4 4v29a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#e8951a"/>
    <path d="M6 23a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v27a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="url(#fsA)"/>
    <circle cx="38" cy="38" r="9" fill="#e9f3ff" stroke="#1e6fd9" stroke-width="4"/><path d="M45 45l8 8" stroke="#1e6fd9" stroke-width="5" stroke-linecap="round"/></svg>`,
  photos: `<svg viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="14" fill="#fff"/>
    <g transform="translate(32 32)"><ellipse rx="7" ry="14" cy="-11" fill="#f9b233" opacity=".9"/><ellipse rx="7" ry="14" cy="-11" fill="#ef5a5a" opacity=".85" transform="rotate(72)"/>
    <ellipse rx="7" ry="14" cy="-11" fill="#a35ee8" opacity=".85" transform="rotate(144)"/><ellipse rx="7" ry="14" cy="-11" fill="#2f8ae6" opacity=".85" transform="rotate(216)"/>
    <ellipse rx="7" ry="14" cy="-11" fill="#2fb36b" opacity=".85" transform="rotate(288)"/></g></svg>`,
  videos: `<svg viewBox="0 0 64 64"><defs><linearGradient id="vdA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a5cf6"/><stop offset="1" stop-color="#5b3cc4"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#vdA)"/><rect x="13" y="18" width="38" height="28" rx="5" fill="none" stroke="#fff" stroke-width="3.5"/><path d="M28 25v14l11-7z" fill="#fff"/></svg>`,
  music: `<svg viewBox="0 0 64 64"><defs><linearGradient id="muA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b8b"/><stop offset="1" stop-color="#e3345b"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#muA)"/><path d="M26 42V20l18-4v22" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/><circle cx="21" cy="42" r="6" fill="#fff"/><circle cx="39" cy="38" r="6" fill="#fff"/></svg>`,
  monitor: `<svg viewBox="0 0 64 64"><defs><linearGradient id="rmA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34475d"/><stop offset="1" stop-color="#1c2836"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#rmA)"/><path d="M12 40h8l5-14 7 22 6-16 4 8h10" fill="none" stroke="#3ddc97" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  control: `<svg viewBox="0 0 64 64"><defs><linearGradient id="cpA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ba7f7"/><stop offset="1" stop-color="#1e6fd9"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#cpA)"/>
    <path d="M18 20h28M18 32h28M18 44h28" stroke="#cfe3fb" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="38" cy="20" r="5" fill="#fff"/><circle cx="25" cy="32" r="5" fill="#fff"/><circle cx="41" cy="44" r="5" fill="#fff"/></svg>`,
  help: `<svg viewBox="0 0 64 64"><defs><linearGradient id="hpA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4fd18b"/><stop offset="1" stop-color="#22a35c"/></linearGradient></defs>
    <path d="M10 12a4 4 0 0 1 4-4h38v48H14a4 4 0 0 1-4-4z" fill="url(#hpA)"/><path d="M10 50a4 4 0 0 1 4-4h38" fill="none" stroke="#d8f6e5" stroke-width="3"/>
    <path d="M26 24a6 6 0 1 1 8 5.6c-1.6.7-2 1.6-2 3.4" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><circle cx="32" cy="39" r="2.4" fill="#fff"/></svg>`,
  upload: `<svg viewBox="0 0 64 64"><defs><linearGradient id="upA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#36c3f0"/><stop offset="1" stop-color="#1688d6"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#upA)"/><path d="M20 40a9 9 0 0 1 1-18 12 12 0 0 1 23 2 8 8 0 0 1 0 16" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><path d="M32 48V30M25 36l7-7 7 7" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  download: `<svg viewBox="0 0 64 64"><defs><linearGradient id="dsA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4fc3f7"/><stop offset="1" stop-color="#0b7bd6"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#dsA)"/><circle cx="32" cy="30" r="15" fill="none" stroke="#fff" stroke-width="3.5" opacity=".35"/>
    <path d="M32 14v26M22 31l10 10 10-10" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 48h28" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/></svg>`,
  player: `<svg viewBox="0 0 64 64"><defs><linearGradient id="mpA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffa53a"/><stop offset="1" stop-color="#f05a28"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#mpA)"/><circle cx="32" cy="32" r="17" fill="rgba(255,255,255,.22)"/><path d="M27 22v20l16-10z" fill="#fff"/></svg>`,
  terminal: `<svg viewBox="0 0 64 64"><defs><linearGradient id="tmA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d3b4e"/><stop offset="1" stop-color="#161e29"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#tmA)"/><path d="M16 22l9 8-9 8" fill="none" stroke="#5bd68a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 42h16" stroke="#9fb0c3" stroke-width="4" stroke-linecap="round"/></svg>`,
  screen: `<svg viewBox="0 0 64 64"><defs><linearGradient id="smA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#36c3f0"/><stop offset="1" stop-color="#5566e0"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#smA)"/><rect x="20" y="12" width="24" height="40" rx="5" fill="none" stroke="#fff" stroke-width="3.2"/><circle cx="32" cy="46" r="2.4" fill="#fff"/><path d="M27 26l6 4-6 4z" fill="#fff"/></svg>`,
  remote: `<svg viewBox="0 0 64 64"><defs><linearGradient id="raA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9d4d"/><stop offset="1" stop-color="#f06a1e"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#raA)"/><circle cx="32" cy="32" r="16" fill="none" stroke="#fff" stroke-width="3"/><path d="M16 32h32M32 16c6 5 6 27 0 32M32 16c-6 5-6 27 0 32" fill="none" stroke="#fff" stroke-width="2.6"/></svg>`,
  packagecenter: `<svg viewBox="0 0 64 64"><defs><linearGradient id="pkA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd15c"/><stop offset="1" stop-color="#f3932b"/></linearGradient></defs>
    <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#pkA)"/><path d="M32 14l16 8v20l-16 8-16-8V22z" fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round"/><path d="M16 22l16 8 16-8M32 30v20" fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round"/></svg>`,
  group: `<svg viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="14" fill="rgba(30,40,55,.55)"/>
    <rect x="13" y="13" width="17" height="17" rx="5" fill="#fff"/><rect x="34" y="13" width="17" height="17" rx="5" fill="#8a5cf6"/><rect x="13" y="34" width="17" height="17" rx="5" fill="#ef5a7a"/><rect x="34" y="34" width="17" height="17" rx="5" fill="#2f8ae6" opacity=".55"/>
    <g transform="translate(21.5 21.5) scale(.18)"><ellipse rx="7" ry="14" cy="-11" fill="#f9b233" transform="rotate(0)"/><ellipse rx="7" ry="14" cy="-11" fill="#2f8ae6" transform="rotate(120)"/><ellipse rx="7" ry="14" cy="-11" fill="#2fb36b" transform="rotate(240)"/></g>
    <path d="M40 18v8l6-4z" fill="#fff"/></svg>`,
};
function appIco(name) { return el('div', { class: 'app-ico', html: APP_ICO[name] || '' }); }

// File-type icons (24x24 artwork drawn at any size).
const FILE_COLORS = { image: '#2fb36b', video: '#8a5cf6', audio: '#ef5a7a', pdf: '#e5484d', text: '#7a8794', archive: '#c08a2e', apk: '#3ddc84', doc: '#2b6fd6', sheet: '#1f9d55', slide: '#e8742a', file: '#9aa6b2' };
const FILE_TAG = { image: 'IMG', video: '▶', audio: '♪', pdf: 'PDF', text: 'TXT', archive: 'ZIP', apk: 'APK', doc: 'DOC', sheet: 'XLS', slide: 'PPT', file: '' };
function fileIcon(kind) {
  if (kind === 'folder') return el('span', { class: 'fi', html: '<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M2 6.5A1.5 1.5 0 0 1 3.5 5H9l2 2h9.5A1.5 1.5 0 0 1 22 8.5V18a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18z" fill="#f5b432"/><path d="M2 9.5A1.5 1.5 0 0 1 3.5 8h17A1.5 1.5 0 0 1 22 9.5V18a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18z" fill="#ffd25e"/></svg>' });
  const c = FILE_COLORS[kind] || FILE_COLORS.file;
  const tag = FILE_TAG[kind] || '';
  return el('span', { class: 'fi', html: `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M5 2h9.5L20 7.5V21a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="#fff" stroke="#c9d2dc" stroke-width=".8"/><path d="M14.5 2v5.5H20" fill="#e9eef3" stroke="#c9d2dc" stroke-width=".8"/>${tag ? `<rect x="2.5" y="12" width="14" height="7" rx="1.5" fill="${c}"/><text x="9.5" y="17.4" font-size="5" font-family="Arial,sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${tag}</text>` : ''}</svg>` });
}

// ---------------------------------------------------------------- state

const State = { roots: [], sys: null, notes: [], clipboard: null, isRoot: false, flavor: 'normal', authMode: 'pin' };

function rootOf(p) {
  let best = null;
  for (const r of State.roots) if ((p === r.path || p.startsWith(r.path + '/')) && (!best || r.path.length > best.path.length)) best = r;
  return best;
}
function displayPath(p) {
  const r = rootOf(p);
  return r ? r.name + p.slice(r.path.length) : p;
}
function notify(text) {
  State.notes.unshift({ text, time: Date.now() });
  State.notes.length = Math.min(State.notes.length, 30);
}

// ---------------------------------------------------------------- window manager

const WM = {
  wins: new Map(),
  z: 100,
  active: null,
  open(app) {
    let w = this.wins.get(app.id);
    if (w) { w.restore(); return w; }
    w = new Win(app);
    this.wins.set(app.id, w);
    Taskbar.render();
    return w;
  },
};

class Win {
  constructor(app) {
    this.app = app;
    const n = WM.wins.size;
    const vw = innerWidth, vh = innerHeight;
    const w = Math.min(app.w || 900, vw - 40), h = Math.min(app.h || 560, vh - 80);
    const x = Math.max(10, Math.min(130 + n * 32, vw - w - 10));
    const y = Math.max(54, Math.min(64 + n * 28, vh - h - 10));
    this.body = el('div', { class: 'win-body' });
    this.maxBtn = el('button', { class: 'win-btn', title: 'ขยาย', onclick: () => this.toggleMax() }, icon('max'));
    this.titleEl = el('div', { class: 'title', text: app.name });
    this.bar = el('div', { class: 'titlebar', ondblclick: e => { if (!e.target.closest('button')) this.toggleMax(); } },
      appIco(app.ico), this.titleEl,
      el('button', { class: 'win-btn', title: 'ย่อ', onclick: () => this.minimize() }, icon('min')),
      this.maxBtn,
      el('button', { class: 'win-btn close', title: 'ปิด', onclick: () => this.close() }, icon('x')));
    this.grip = el('div', { class: 'resize' });
    this.el = el('section', { class: 'window', style: { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' } }, this.bar, this.body, this.grip);
    this.el.addEventListener('pointerdown', () => this.focus(), true);
    document.body.append(this.el);
    this.drag();
    this.focus();
    this.ctl = app.mount(this.body, this) || {};
  }
  setTitle(t) { this.titleEl.textContent = t; }
  focus() {
    if (WM.active && WM.active !== this) WM.active.el.classList.add('inactive');
    this.el.classList.remove('inactive');
    this.el.style.zIndex = ++WM.z;
    WM.active = this;
    Taskbar.render();
  }
  minimize() {
    this.el.classList.add('hidden');
    this.minimized = true;
    if (WM.active === this) WM.active = null;
    Taskbar.render();
  }
  restore() {
    this.el.classList.remove('hidden');
    this.minimized = false;
    this.focus();
  }
  toggleMax() {
    if (!this.max) {
      this.prev = this.el.getAttribute('style');
      Object.assign(this.el.style, { left: '0px', top: 'var(--bar-h)', width: '100%', height: 'calc(100% - var(--bar-h))' });
      this.el.classList.add('max');
      this.maxBtn.replaceChildren(icon('restore'));
    } else {
      this.el.setAttribute('style', this.prev);
      this.el.style.zIndex = ++WM.z;
      this.el.classList.remove('max');
      this.maxBtn.replaceChildren(icon('max'));
    }
    this.max = !this.max;
  }
  close() {
    if (this.ctl.destroy) this.ctl.destroy();
    this.el.remove();
    WM.wins.delete(this.app.id);
    if (WM.active === this) WM.active = null;
    Taskbar.render();
  }
  drag() {
    const track = (handle, onMove) => handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button') || this.max || innerWidth <= 760) return;
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      const move = ev => onMove(r, ev.clientX - sx, ev.clientY - sy);
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    track(this.bar, (r, dx, dy) => {
      this.el.style.left = Math.min(innerWidth - 80, Math.max(-r.width + 80, r.left + dx)) + 'px';
      this.el.style.top = Math.min(innerHeight - 40, Math.max(44, r.top + dy)) + 'px';
    });
    track(this.grip, (r, dx, dy) => {
      this.el.style.width = Math.max(320, r.width + dx) + 'px';
      this.el.style.height = Math.max(220, r.height + dy) + 'px';
    });
  }
}

// ---------------------------------------------------------------- taskbar & desktop

const Taskbar = {
  pinned: ['filestation', 'download'],
  render() {
    const box = $('#taskApps');
    box.replaceChildren();
    const ids = [...this.pinned];
    for (const id of WM.wins.keys()) if (!ids.includes(id)) ids.push(id);
    for (const id of ids) {
      const app = APPS[id];
      const w = WM.wins.get(id);
      const b = el('button', {
        class: 'tb-btn' + (w ? ' open' : '') + (w && w.minimized ? ' minimized' : '') + (w && WM.active === w ? ' active' : ''),
        title: app.name,
        onclick: () => {
          if (!w) openApp(id);
          else if (WM.active === w && !w.minimized) w.minimize();
          else w.restore();
        },
      }, appIco(app.ico));
      box.append(b);
    }
  },
};

function openApp(id, arg) {
  closePop();
  const w = WM.open(APPS[id]);
  if (arg && w.ctl.handle) w.ctl.handle(arg);
  return w;
}

const DESKTOP = [
  { app: 'filestation' },
  { app: 'download' },
  { group: 'Multimedia', ico: 'group', apps: ['player', 'photos', 'videos', 'music', 'wallpaper'] },
  { app: 'monitor' },
  { app: 'remote' },
  { app: 'packagecenter' },
  { app: 'terminal', root: true },
  { app: 'screen', root: true },
  { app: 'control', badge: () => controlBadge() },
  { app: 'help' },
];

function controlBadge() {
  let n = 0;
  if (State.roots.length && !State.roots[0].readable) n++;
  if (Auth.pinRequired === false) n++;
  return n;
}

function renderDesktop() {
  const d = $('#desktop');
  d.replaceChildren();
  for (const it of DESKTOP) {
    if (it.root && !State.isRoot) continue;
    const app = it.app ? APPS[it.app] : null;
    const badge = it.badge ? it.badge() : 0;
    const btn = el('button', { class: 'desk-icon' }, appIco(app ? app.ico : it.ico), el('div', { class: 'lbl', text: app ? app.name : it.group }), badge ? el('span', { class: 'badge', text: badge }) : null);
    btn.addEventListener(innerWidth <= 760 ? 'click' : 'dblclick', () => app ? openApp(it.app) : groupPopover(btn, it));
    if (!app) btn.addEventListener('click', () => groupPopover(btn, it));
    d.append(btn);
  }
}

function appGridPopover(anchorBtn, ids, title, three) {
  closePop();
  const grid = el('div', { class: 'pop-grid' + (three ? ' three' : '') });
  const fill = q => {
    grid.replaceChildren();
    for (const id of ids) {
      const a = APPS[id];
      if (q && !a.name.toLowerCase().includes(q.toLowerCase())) continue;
      grid.append(el('button', { class: 'pop-tile', onclick: () => openApp(id) }, appIco(a.ico), a.name));
    }
  };
  const search = el('input', { class: 'search', placeholder: title || 'ค้นหา', oninput: e => fill(e.target.value) });
  const pop = el('div', { class: 'popover' }, search, grid);
  fill('');
  document.body.append(pop);
  const r = anchorBtn.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pr.width - 8)) + 'px';
  pop.style.top = (anchorBtn.id === 'mainMenuBtn' ? r.bottom + 6 : Math.min(r.top, innerHeight - pr.height - 8)) + 'px';
  if (anchorBtn.classList.contains('desk-icon') && innerWidth > 760) pop.style.left = (r.right + 8) + 'px';
  anchorBtn.classList.add('active');
  openPop = { el: pop, btn: anchorBtn };
  if (innerWidth > 760) search.focus();
}
function groupPopover(btn, it) { appGridPopover(btn, it.apps, 'ค้นหาใน ' + it.group, true); }

// ---------------------------------------------------------------- File Station

function FileStation(body, win) {
  const st = {
    path: null, back: [], fwd: [], entries: [], shown: [], sel: new Set(), anchor: null,
    sort: store.get('sort', { key: 'name', desc: false }), view: store.get('view', 'list'),
    hidden: store.get('hidden', false), searching: null,
  };

  const backBtn = el('button', { class: 'icon-btn', title: 'ย้อนกลับ', onclick: () => history(-1) }, icon('back'));
  const fwdBtn = el('button', { class: 'icon-btn', title: 'ไปข้างหน้า', onclick: () => history(1) }, icon('fwd'));
  const upBtn = el('button', { class: 'icon-btn hide-sm', title: 'โฟลเดอร์แม่', onclick: () => st.parent && go(st.parent) }, icon('up'));
  const crumbs = el('div', { class: 'crumbs' });
  const searchIn = el('input', { placeholder: 'ค้นหาในโฟลเดอร์นี้', onkeydown: e => {
    if (e.key === 'Enter') doSearch(searchIn.value.trim());
    if (e.key === 'Escape') { searchIn.value = ''; if (st.searching) load(); }
  } });
  const nav = el('div', { class: 'fs-nav' }, backBtn, fwdBtn, upBtn,
    el('button', { class: 'icon-btn', title: 'รีเฟรช', onclick: () => load() }, icon('refresh')),
    crumbs, el('div', { class: 'fs-search' }, icon('search'), searchIn));

  const uploadBtn = el('button', { class: 'btn primary', onclick: e => menuAt(e.currentTarget, [
    { label: 'อัปโหลดไฟล์', ico: 'upload', run: () => pick('#filePick') },
    { label: 'อัปโหลดทั้งโฟลเดอร์', ico: 'folderUp', run: () => pick('#folderPick') },
  ]) }, icon('upload'), 'อัปโหลด', icon('chev', 'chev'));
  const createBtn = el('button', { class: 'btn', onclick: () => mkdir() }, icon('newfolder'), el('span', { class: 'hide-sm', text: 'สร้างโฟลเดอร์' }));
  const actionBtn = el('button', { class: 'btn', onclick: e => menuAt(e.currentTarget, actionItems()) }, 'การทำงาน', icon('chev', 'chev'));
  const dlBtn = el('button', { class: 'btn', onclick: () => download() }, icon('download'), el('span', { class: 'hide-sm', text: 'ดาวน์โหลด' }));
  const delBtn = el('button', { class: 'btn hide-sm', onclick: () => del() }, icon('trash'));
  const viewList = el('button', { class: 'icon-btn', title: 'มุมมองรายการ', onclick: () => setView('list') }, icon('list'));
  const viewGrid = el('button', { class: 'icon-btn', title: 'มุมมองไอคอน', onclick: () => setView('grid') }, icon('grid'));
  const hidBtn = el('button', { class: 'icon-btn hide-sm', title: 'แสดงไฟล์ซ่อน', onclick: () => { st.hidden = !st.hidden; store.set('hidden', st.hidden); render(); } }, icon('eye'));
  const tools = el('div', { class: 'fs-tools' }, uploadBtn, createBtn, actionBtn, dlBtn, delBtn, el('div', { class: 'grow' }), hidBtn, viewList, viewGrid);

  const list = el('div', { class: 'fs-list', tabindex: '0' });
  const status = el('div', { class: 'fs-status' });
  const side = el('div', { class: 'fs-side' });
  const main = el('div', { class: 'fs-main' }, nav, tools, list, status);
  body.append(el('div', { class: 'fs' }, side, main));

  // ---- sidebar tree
  function treeNode(name, path, depth) {
    const kids = el('div', { class: 'tree-kids hidden' });
    const caret = el('span', { class: 'caret' }, icon('caret'));
    const row = el('div', { class: 'tn', 'data-path': path, title: path }, caret, fileIcon('folder'), el('span', { class: 'nm', text: name }));
    let loaded = false;
    const toggle = async open => {
      const willOpen = open ?? kids.classList.contains('hidden');
      kids.classList.toggle('hidden', !willOpen);
      caret.classList.toggle('open', willOpen);
      if (willOpen && !loaded) {
        loaded = true;
        try {
          const r = await api('list', { path });
          const dirs = r.entries.filter(e => e.dir && !e.hidden).sort((a, b) => a.name.localeCompare(b.name));
          if (!dirs.length) caret.classList.add('none');
          for (const d of dirs) kids.append(treeNode(d.name, d.path, depth + 1));
        } catch { caret.classList.add('none'); }
      }
    };
    caret.addEventListener('click', e => { e.stopPropagation(); toggle(); });
    row.addEventListener('click', () => { go(path); toggle(true); });
    return el('div', { class: 'tree-node' }, row, kids);
  }
  function buildSide() {
    side.replaceChildren(el('div', { class: 'sec', text: 'ที่เก็บข้อมูล' }));
    for (const r of State.roots) side.append(treeNode(r.name, r.path, 0));
    const main = State.roots[0];
    if (main) {
      side.append(el('div', { class: 'sec', text: 'เข้าถึงด่วน' }));
      for (const [n, label] of [['DCIM', 'กล้อง (DCIM)'], ['Pictures', 'รูปภาพ'], ['Download', 'ดาวน์โหลด'], ['Documents', 'เอกสาร'], ['Movies', 'วิดีโอ'], ['Music', 'เพลง']]) {
        const p = main.path + '/' + n;
        side.append(el('div', { class: 'tree-node' }, el('div', { class: 'tn', 'data-path': p, onclick: () => go(p) },
          el('span', { class: 'caret none' }), fileIcon('folder'), el('span', { class: 'nm', text: label }))));
      }
    }
  }
  function markSide() {
    for (const n of side.querySelectorAll('.tn')) n.classList.toggle('cur', n.dataset.path === st.path && !st.searching);
  }

  // ---- navigation
  async function go(path, push = true) {
    if (push && st.path && st.path !== path) { st.back.push(st.path); st.fwd = []; }
    st.path = path;
    st.searching = null;
    searchIn.value = '';
    await load();
  }
  function history(dir) {
    const from = dir < 0 ? st.back : st.fwd, to = dir < 0 ? st.fwd : st.back;
    if (!from.length) return;
    to.push(st.path);
    go(from.pop(), false);
  }
  async function load(keepSel) {
    if (!st.path) return;
    if (!keepSel) st.sel.clear();
    st.searching = null;
    list.replaceChildren(el('div', { class: 'empty', text: 'กำลังโหลด…' }));
    try {
      const r = await api('list', { path: st.path });
      st.entries = r.entries;
      st.parent = r.parent;
      st.error = null;
    } catch (e) {
      st.entries = [];
      st.parent = null;
      st.error = e.message === 'no_permission'
        ? 'แอป NexShare บนมือถือยังไม่ได้รับสิทธิ์เข้าถึงไฟล์ — เปิดแอปบนมือถือแล้วกด "อนุญาตให้เข้าถึงไฟล์ทั้งหมด"'
        : 'เปิดโฟลเดอร์นี้ไม่ได้ (' + e.message + ')';
    }
    render();
  }
  async function doSearch(q) {
    if (!q) return load();
    st.searching = q;
    st.sel.clear();
    list.replaceChildren(el('div', { class: 'empty', text: 'กำลังค้นหา…' }));
    try {
      const r = await api('search', { path: st.path, q });
      st.entries = r.entries;
      st.error = null;
    } catch (e) { st.entries = []; st.error = e.message; }
    render();
  }

  // ---- rendering
  function sorted() {
    const { key, desc } = st.sort;
    const arr = st.entries.filter(e => st.hidden || !e.hidden);
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      size: (a, b) => a.size - b.size,
      mtime: (a, b) => a.mtime - b.mtime,
      type: (a, b) => kindOf(a).localeCompare(kindOf(b)) || extOf(a.name).localeCompare(extOf(b.name)),
    }[key];
    arr.sort((a, b) => (b.dir - a.dir) || (desc ? -cmp(a, b) : cmp(a, b)));
    return arr;
  }

  function renderCrumbs() {
    crumbs.replaceChildren();
    const r = rootOf(st.path || '');
    if (!r) return;
    const parts = st.path.slice(r.path.length).split('/').filter(Boolean);
    let acc = r.path;
    crumbs.append(el('button', { text: r.name, onclick: () => go(r.path) }));
    for (const p of parts) {
      acc += '/' + p;
      const target = acc;
      crumbs.append(el('span', { class: 'sep', text: '›' }), el('button', { text: p, onclick: () => go(target) }));
    }
    if (st.searching) crumbs.append(el('span', { class: 'sep', text: '›' }), el('button', { text: `ผลการค้นหา "${st.searching}"` }));
    crumbs.scrollLeft = crumbs.scrollWidth;
  }

  function render() {
    st.shown = sorted();
    renderCrumbs();
    markSide();
    backBtn.disabled = !st.back.length;
    fwdBtn.disabled = !st.fwd.length;
    upBtn.disabled = !st.parent;
    viewList.classList.toggle('on', st.view === 'list');
    viewGrid.classList.toggle('on', st.view === 'grid');
    hidBtn.classList.toggle('on', st.hidden);
    win.setTitle('File Station' + (st.path ? ' — ' + displayPath(st.path).split('/').pop() : ''));
    list.replaceChildren();
    if (st.error) { list.append(el('div', { class: 'notice', text: st.error })); updateSel(); return; }
    if (!st.shown.length) {
      list.append(el('div', { class: 'empty' }, fileIcon('folder'), st.searching ? 'ไม่พบไฟล์ที่ตรงกัน' : 'โฟลเดอร์นี้ว่างเปล่า — ลากไฟล์มาวางเพื่ออัปโหลด'));
      updateSel();
      return;
    }
    if (st.view === 'grid') renderGrid(); else renderTable();
    updateSel();
  }

  function renderTable() {
    const th = (key, label, cls) => el('th', {
      class: [cls, st.sort.key === key ? 'sorted' : '', st.sort.key === key && st.sort.desc ? 'desc' : ''].filter(Boolean).join(' '),
      onclick: () => { st.sort = { key, desc: st.sort.key === key ? !st.sort.desc : false }; store.set('sort', st.sort); render(); },
    }, label);
    const allChk = el('input', { type: 'checkbox', onclick: e => { e.stopPropagation(); if (e.target.checked) st.shown.forEach(x => st.sel.add(x.path)); else st.sel.clear(); updateSel(); } });
    const colgroup = el('colgroup', null, el('col', { style: { width: '36px' } }), el('col'), el('col', { style: { width: '96px' } }), el('col', { class: 'col-type', style: { width: '110px' } }), el('col', { class: 'col-date', style: { width: '150px' } }));
    const tbody = el('tbody');
    for (const e of st.shown) {
      const kind = kindOf(e);
      const chk = el('input', { type: 'checkbox', onclick: ev => { ev.stopPropagation(); toggleSel(e.path, ev.target.checked); } });
      const tr = el('tr', { 'data-path': e.path, class: e.hidden ? 'hidden-file' : null },
        el('td', { class: 'chk' }, chk),
        el('td', { class: 'name', title: e.name }, el('div', null, fileIcon(kind), el('span', { text: e.name }))),
        el('td', { class: 'dim', text: e.dir ? '' : fmtSize(e.size) }),
        el('td', { class: 'dim col-type', text: e.dir ? KIND_LABEL.folder : (extOf(e.name).toUpperCase() || KIND_LABEL.file) }),
        el('td', { class: 'dim col-date', text: fmtDate(e.mtime) }));
      bindItem(tr, e);
      tbody.append(tr);
    }
    list.append(el('table', { class: 'files' }, colgroup,
      el('thead', null, el('tr', null, el('th', { class: 'chk' }, allChk), th('name', 'ชื่อ'), th('size', 'ขนาด'), th('type', 'ชนิด', 'col-type'), th('mtime', 'แก้ไขล่าสุด', 'col-date'))),
      tbody));
  }

  function renderGrid() {
    const g = el('div', { class: 'grid-files' });
    for (const e of st.shown) {
      const kind = kindOf(e);
      const pic = el('div', { class: 'pic' });
      if (kind === 'image' || kind === 'video') {
        const img = el('img', { loading: 'lazy', src: thumbUrl(e.path, 200), alt: '' });
        img.onerror = () => img.replaceWith(fileIcon(kind));
        pic.append(img);
      } else pic.append(fileIcon(kind));
      const item = el('div', { class: 'gf', 'data-path': e.path, title: e.name }, pic, el('div', { class: 'nm', text: e.name }));
      bindItem(item, e);
      g.append(item);
    }
    list.append(g);
  }

  // ---- selection
  const coarse = matchMedia('(pointer: coarse)').matches;
  function bindItem(node, e) {
    node.addEventListener('click', ev => {
      if (coarse && !ev.ctrlKey && !ev.shiftKey && !st.sel.size) { open(e); return; }
      if (ev.shiftKey && st.anchor) {
        const a = st.shown.findIndex(x => x.path === st.anchor), b = st.shown.findIndex(x => x.path === e.path);
        if (!ev.ctrlKey) st.sel.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) st.sel.add(st.shown[i].path);
      } else if (ev.ctrlKey || ev.metaKey || (coarse && st.sel.size)) {
        toggleSel(e.path, !st.sel.has(e.path));
        st.anchor = e.path;
        return;
      } else {
        st.sel.clear();
        st.sel.add(e.path);
        st.anchor = e.path;
      }
      updateSel();
    });
    node.addEventListener('dblclick', () => open(e));
    node.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      if (!st.sel.has(e.path)) { st.sel.clear(); st.sel.add(e.path); st.anchor = e.path; updateSel(); }
      menu(actionItems(), ev.clientX, ev.clientY);
    });
  }
  function toggleSel(p, on) {
    if (on) st.sel.add(p); else st.sel.delete(p);
    updateSel();
  }
  function updateSel() {
    for (const n of list.querySelectorAll('[data-path]')) {
      const on = st.sel.has(n.dataset.path);
      n.classList.toggle('sel', on);
      const c = n.querySelector('input[type=checkbox]');
      if (c) c.checked = on;
    }
    const n = st.sel.size;
    dlBtn.disabled = !n;
    delBtn.disabled = !n;
    const files = st.shown.filter(e => !e.dir).length, dirs = st.shown.length - files;
    const size = selected().reduce((s, e) => s + (e.dir ? 0 : e.size), 0);
    status.replaceChildren(...[
      el('span', { text: `${st.shown.length} รายการ (${dirs} โฟลเดอร์, ${files} ไฟล์)` }),
      n ? el('span', { text: `เลือก ${n} รายการ${size ? ' · ' + fmtSize(size) : ''}` }) : null,
      State.clipboard ? el('span', { text: `คลิปบอร์ด: ${State.clipboard.paths.length} รายการ (${State.clipboard.move ? 'ตัด' : 'คัดลอก'})` }) : null].filter(Boolean));
  }
  const selected = () => st.shown.filter(e => st.sel.has(e.path));

  list.addEventListener('click', e => { if (e.target === list || e.target.classList.contains('grid-files')) { st.sel.clear(); updateSel(); } });
  list.addEventListener('contextmenu', e => {
    if (e.target.closest('[data-path]')) return;
    e.preventDefault();
    st.sel.clear();
    updateSel();
    menu([
      { label: 'สร้างโฟลเดอร์', ico: 'newfolder', run: mkdir },
      { label: 'อัปโหลดไฟล์', ico: 'upload', run: () => pick('#filePick') },
      { label: 'อัปโหลดทั้งโฟลเดอร์', ico: 'folderUp', run: () => pick('#folderPick') },
      State.clipboard && { label: 'วาง', ico: 'paste', run: paste },
      '-',
      { label: 'รีเฟรช', ico: 'refresh', run: () => load() },
    ], e.clientX, e.clientY);
  });
  list.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Delete') del();
    else if (e.key === 'F2') rename();
    else if (e.key === 'Backspace' && st.parent) go(st.parent);
    else if (e.key === 'Enter' && st.sel.size === 1) open(selected()[0]);
    else if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); st.shown.forEach(x => st.sel.add(x.path)); updateSel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && st.sel.size) clip(false);
    else if ((e.ctrlKey || e.metaKey) && e.key === 'x' && st.sel.size) clip(true);
    else if ((e.ctrlKey || e.metaKey) && e.key === 'v' && State.clipboard) paste();
  });

  // ---- actions
  function actionItems() {
    const sel = selected(), one = sel.length === 1 ? sel[0] : null;
    return [
      { label: 'เปิด', ico: 'open', disabled: !one, run: () => open(one) },
      { label: 'ดาวน์โหลด', ico: 'download', disabled: !sel.length, run: download },
      { label: 'ดาวน์โหลดเป็น ZIP', ico: 'zip', disabled: !sel.length, run: () => download(true) },
      { label: 'คัดลอกลิงก์ดาวน์โหลด', ico: 'link', disabled: !one || one.dir, run: () => copyLink(one) },
      one && /\.torrent$/i.test(one.name) ? { label: 'เพิ่มใน Download Station', ico: 'download', run: () => addTorrentFromPhone(one) } : null,
      one && !one.dir && kindOf(one) === 'image' ? { label: 'ตั้งเป็นวอลเปเปอร์', ico: 'open', run: () => setWallpaperFromFile(one) } : null,
      '-',
      { label: 'เปลี่ยนชื่อ', ico: 'rename', disabled: !one, run: rename },
      { label: 'คัดลอก', ico: 'copy', disabled: !sel.length, run: () => clip(false) },
      { label: 'ตัด', ico: 'cut', disabled: !sel.length, run: () => clip(true) },
      { label: 'วาง', ico: 'paste', disabled: !State.clipboard, run: paste },
      '-',
      { label: 'ลบ', ico: 'trash', danger: true, disabled: !sel.length, run: del },
    ];
  }
  async function setWallpaperFromFile(e) {
    try { await api('wallpaper', { path: e.path }, { method: 'POST' }); toast('ตั้งวอลเปเปอร์แล้ว'); }
    catch (x) { toast('ไม่สำเร็จ: ' + x.message); }
  }
  async function addTorrentFromPhone(e) {
    try {
      const blob = await (await fetch(fileUrl(e.path))).blob();
      if (await submitDownloads({ urls: '', dest: '', torrentFile: blob })) openApp('download');
    } catch (x) { toast('ไม่สำเร็จ: ' + x.message); }
  }
  function open(e) {
    if (e.dir) go(e.path);
    else openEntry(e, st.shown.filter(x => !x.dir), st.entries);
  }
  function download(asZip) {
    const sel = selected();
    if (!sel.length) return;
    const url = !asZip && sel.length === 1 && !sel[0].dir ? fileUrl(sel[0].path, true) : '/api/zip' + qs({ p: sel.map(e => e.path) });
    const a = el('a', { href: url, download: '' });
    document.body.append(a);
    a.click();
    a.remove();
  }
  function copyLink(e) {
    const url = location.origin + fileUrl(e.path, true);
    const done = () => toast('คัดลอกลิงก์แล้ว (ผู้รับต้องอยู่ใน Wi-Fi เดียวกัน)');
    if (navigator.clipboard && isSecureContext) navigator.clipboard.writeText(url).then(done, () => dialog({ title: 'ลิงก์ดาวน์โหลด', input: url, cancel: false }));
    else dialog({ title: 'ลิงก์ดาวน์โหลด', input: url, cancel: false });
  }
  async function mkdir() {
    const name = await dialog({ title: 'สร้างโฟลเดอร์', input: 'โฟลเดอร์ใหม่', okText: 'สร้าง' });
    if (!name) return;
    try { await api('mkdir', { path: st.path, name }, { method: 'POST' }); await load(); toast('สร้างโฟลเดอร์แล้ว'); }
    catch (e) { toast(e.status === 409 ? 'มีชื่อนี้อยู่แล้ว' : 'สร้างไม่สำเร็จ: ' + e.message); }
  }
  async function rename() {
    const e = selected()[0];
    if (!e) return;
    const name = await dialog({ title: 'เปลี่ยนชื่อ', input: e.name, okText: 'บันทึก' });
    if (!name || name === e.name) return;
    try { await api('rename', { path: e.path, name }, { method: 'POST' }); await load(); }
    catch (err) { toast(err.status === 409 ? 'มีชื่อนี้อยู่แล้ว' : 'เปลี่ยนชื่อไม่สำเร็จ'); }
  }
  async function del() {
    const sel = selected();
    if (!sel.length) return;
    const ok = await dialog({ title: 'ลบ ' + (sel.length === 1 ? `"${sel[0].name}"` : sel.length + ' รายการ') + '?', message: 'ไฟล์จะถูกลบออกจากมือถือถาวร กู้คืนไม่ได้', okText: 'ลบ', danger: true });
    if (!ok) return;
    try { const r = await api('delete', { p: sel.map(e => e.path) }, { method: 'POST' }); toast(`ลบแล้ว ${r.deleted} รายการ`); }
    catch (e) { toast('ลบไม่สำเร็จ: ' + e.message); }
    load();
  }
  function clip(move) {
    State.clipboard = { move, paths: selected().map(e => e.path) };
    toast((move ? 'ตัด ' : 'คัดลอก ') + State.clipboard.paths.length + ' รายการ — ไปที่โฟลเดอร์ปลายทางแล้วกด วาง');
    updateSel();
  }
  async function paste() {
    const c = State.clipboard;
    if (!c) return;
    toast('กำลัง' + (c.move ? 'ย้าย' : 'คัดลอก') + '…');
    try {
      const r = await api(c.move ? 'move' : 'copy', { dst: st.path, p: c.paths }, { method: 'POST' });
      toast(`${c.move ? 'ย้าย' : 'คัดลอก'}แล้ว ${r.done} รายการ`);
      if (c.move) State.clipboard = null;
    } catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
    load();
  }
  function pick(sel) {
    const input = $(sel);
    input.value = '';
    input.onchange = () => {
      Uploader.add([...input.files].map(f => ({ file: f, rel: (f.webkitRelativePath || '').split('/').slice(0, -1).join('/') })), st.path);
    };
    input.click();
  }
  function setView(v) { st.view = v; store.set('view', v); render(); }

  // ---- drag & drop upload
  let dragDepth = 0;
  list.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; list.classList.add('drop'); } });
  list.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; list.classList.remove('drop'); } });
  list.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  list.addEventListener('drop', async e => {
    e.preventDefault();
    dragDepth = 0;
    list.classList.remove('drop');
    if (!st.path || st.error) return;
    const dest = st.path;
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) { Uploader.add([...e.dataTransfer.files].map(f => ({ file: f, rel: '' })), dest); return; }
    const out = [];
    const walk = (entry, rel) => new Promise(res => {
      if (entry.isFile) entry.file(f => { out.push({ file: f, rel }); res(); }, () => res());
      else {
        const reader = entry.createReader();
        const sub = rel ? rel + '/' + entry.name : entry.name;
        const batch = () => reader.readEntries(async items => {
          if (!items.length) return res();
          for (const it of items) await walk(it, sub);
          batch();
        }, () => res());
        batch();
      }
    });
    for (const en of entries) await walk(en, '');
    Uploader.add(out, dest);
  });

  const onUploaded = dest => { if (st.path && !st.searching && (dest === st.path || dest.startsWith(st.path + '/'))) load(true); };
  Uploader.listeners.add(onUploaded);

  buildSide();
  go(State.roots[0] ? State.roots[0].path : null);
  setTimeout(() => list.focus(), 50);

  return {
    handle(arg) { if (arg.path) go(arg.path); if (arg.search) { searchIn.focus(); } },
    destroy() { Uploader.listeners.delete(onUploaded); },
  };
}

// ---------------------------------------------------------------- media apps

function MediaApp(type) {
  return (body, win) => {
    const pane = el('div', { class: 'photos' }, el('div', { class: 'empty', text: 'กำลังโหลด…' }));
    body.append(pane);
    (async () => {
      try {
        const r = await api('media', { type });
        const items = r.entries;
        pane.replaceChildren();
        if (!items.length) { pane.append(el('div', { class: 'empty', text: 'ไม่พบไฟล์' })); return; }
        win.setTitle(win.app.name + ' — ' + items.length + ' รายการ');
        if (type === 'audio') return renderAudio(items);
        let month = null, grid = null;
        for (const e of items) {
          const d = new Date(e.mtime);
          const m = d.toLocaleDateString('th-TH', { year: 'numeric', month: 'long' });
          if (m !== month) { month = m; grid = el('div', { class: 'ph-grid' }); pane.append(el('h4', { text: m }), grid); }
          const img = el('img', { loading: 'lazy', src: thumbUrl(e.path, 260), alt: '' });
          img.onerror = () => img.replaceWith(fileIcon(kindOf(e)));
          grid.append(el('div', { class: 'ph', title: e.name, onclick: () => openEntry(e, items) }, img,
            kindOf(e) === 'video' ? el('div', { class: 'play' }, icon('play')) : null));
        }
      } catch (e) { pane.replaceChildren(el('div', { class: 'notice', text: 'โหลดไม่สำเร็จ: ' + e.message })); }
    })();
    function renderAudio(items) {
      const tbody = el('tbody');
      items.forEach(e => tbody.append(el('tr', { onclick: () => openEntry(e, items) },
        el('td', { class: 'name' }, el('div', null, fileIcon('audio'), el('span', { text: e.name }))),
        el('td', { class: 'dim', text: fmtSize(e.size), style: { width: '90px' } }))));
      pane.append(el('div', { style: { margin: '12px 2px', color: 'var(--text-2)' }, text: 'กดที่เพลงเพื่อเปิดใน Media Player (เล่นต่อเนื่องทั้งรายการ)' }), el('table', { class: 'files' }, tbody));
    }
    return {};
  };
}

// ---------------------------------------------------------------- Resource Monitor / Control Panel / Help

const Stats = { hist: { cpu: [], ram: [], up: [], down: [] }, last: null, listeners: new Set() };

function drawChart(canvas, series, max, noLabels) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const top = max || Math.max(1, ...series.flatMap(s => s.data)) * 1.15;
  c.strokeStyle = '#e7ecf2';
  c.lineWidth = 1;
  c.fillStyle = '#9aa6b2';
  c.font = '10px sans-serif';
  const steps = noLabels ? 5 : 2;
  for (let i = 0; i <= steps; i++) {
    const y = Math.round(4 + (h - 8) * i / steps) + .5;
    c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    if (max && !noLabels) c.fillText(String(Math.round(max * (1 - i / steps))), 2, i === 0 ? y + 10 : y - 2);
  }
  const N = 60;
  for (const s of series) {
    if (!s.data.length) continue;
    c.beginPath();
    s.data.forEach((v, i) => {
      const x = w - (s.data.length - 1 - i) * (w / (N - 1));
      const y = 4 + (h - 8) * (1 - Math.min(v, top) / top);
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    });
    c.strokeStyle = s.color;
    c.lineWidth = 1.8;
    c.stroke();
    c.lineTo(w, h); c.lineTo(w - (s.data.length - 1) * (w / (N - 1)), h); c.closePath();
    c.globalAlpha = .1; c.fillStyle = s.color; c.fill(); c.globalAlpha = 1;
  }
}

function ResourceMonitor(body) {
  const mk = (title) => {
    const val = el('div', { class: 'val', text: '-' });
    const sub = el('div', { class: 'dim', style: { fontSize: '12px', color: 'var(--text-2)', marginBottom: '8px' } });
    const cv = el('canvas', { class: 'chart' });
    return { card: el('div', { class: 'card' }, el('h4', { text: title }), val, sub, cv), val, sub, cv };
  };
  const cpu = mk('CPU'), ram = mk('หน่วยความจำ (RAM)'), net = mk('เครือข่าย'), conn = mk('การเชื่อมต่อ');
  conn.cv.remove();
  body.append(el('div', { class: 'pane' }, el('div', { class: 'rm-grid' }, cpu.card, ram.card, net.card, conn.card)));
  const update = s => {
    const H = Stats.hist;
    cpu.val.textContent = s.cpu >= 0 ? s.cpu.toFixed(0) + '%' : 'N/A';
    cpu.sub.textContent = s.cores + ' คอร์';
    drawChart(cpu.cv, [{ data: H.cpu, color: '#1e6fd9' }], 100);
    const used = s.memTotal - s.memAvail;
    ram.val.textContent = Math.round(used / s.memTotal * 100) + '%';
    ram.sub.textContent = fmtSize(used) + ' / ' + fmtSize(s.memTotal);
    drawChart(ram.cv, [{ data: H.ram, color: '#2fb36b' }], 100);
    net.val.replaceChildren(el('span', { style: { color: 'var(--up)' }, text: '▲ ' + fmtRate(Stats.up) }), ' ', el('span', { style: { color: 'var(--down)', fontSize: '20px' }, text: '▼ ' + fmtRate(Stats.down) }));
    net.sub.textContent = 'รับรวม ' + fmtSize(s.rx) + ' · ส่งรวม ' + fmtSize(s.tx);
    drawChart(net.cv, [{ data: H.up, color: '#2a8cf0' }, { data: H.down, color: '#32b67a' }]);
    conn.val.textContent = s.connections;
    conn.sub.textContent = 'การเชื่อมต่อ HTTP ที่เปิดอยู่ตอนนี้ · แบตเตอรี่ ' + (s.battery >= 0 ? s.battery + '%' : '-') + (s.charging ? ' (กำลังชาร์จ)' : '') + (s.batteryTemp ? ' · ' + s.batteryTemp + '°C' : '');
  };
  Stats.listeners.add(update);
  if (Stats.last) update(Stats.last);
  return { destroy() { Stats.listeners.delete(update); } };
}

function ControlPanel(body) {
  const pane = el('div', { class: 'pane' });
  body.append(pane);
  const render = () => {
    const s = Stats.last || {};
    const urls = [`http://${s.host || 'nexshare.local'}:${s.port || 8080}`, s.ip ? `http://${s.ip}:${s.port}` : null].filter(Boolean);
    fill(pane,
      el('h2', { text: 'แผงควบคุม' }),
      State.roots.length && !State.roots[0].readable ? el('div', { class: 'notice', style: { margin: '0 0 12px' }, text: 'ยังไม่ได้ให้สิทธิ์เข้าถึงไฟล์ — เปิดแอป NexShare บนมือถือแล้วกด "อนุญาตให้เข้าถึงไฟล์ทั้งหมด"' }) : null,
      Auth.pinRequired === false ? el('div', { class: 'notice', style: { margin: '0 0 12px' }, text: 'ปิดการใช้ PIN อยู่ ใครก็ตามใน Wi-Fi เดียวกันเข้าถึงไฟล์ได้ เปิด PIN ได้ในแอปบนมือถือ' }) : null,
      el('div', { class: 'card' }, el('h3', { text: 'อุปกรณ์', style: { marginTop: 0 } }), el('dl', { class: 'kv' },
        el('dt', { text: 'ชื่อเซิร์ฟเวอร์' }), el('dd', { text: s.name || '-' }),
        el('dt', { text: 'รุ่น' }), el('dd', { text: s.model || '-' }),
        el('dt', { text: 'Android' }), el('dd', { text: s.android ? `${s.android} (API ${s.sdk})` : '-' }),
        el('dt', { text: 'เปิดเครื่องมาแล้ว' }), el('dd', { text: s.uptime ? fmtUptime(s.uptime) : '-' }))),
      el('div', { class: 'card' }, el('h3', { text: 'การเข้าถึงจากเครื่องอื่น', style: { marginTop: 0 } }), el('dl', { class: 'kv' },
        ...urls.flatMap((u, i) => [el('dt', { text: i ? 'ผ่าน IP' : 'Local domain' }), el('dd', { class: 'mono', text: u })]),
        el('dt', { text: 'ความปลอดภัย' }), el('dd', { text: State.authMode === 'password' ? 'ชื่อผู้ใช้ + รหัสผ่าน' : State.authMode === 'pin' ? 'ต้องใส่ PIN' : 'ไม่ต้องล็อกอิน' }))),
      el('div', { class: 'card' }, el('h3', { text: 'ที่เก็บข้อมูล', style: { marginTop: 0 } }),
        ...State.roots.map(r => el('div', { class: 'meter' },
          el('div', { class: 'row' }, el('span', { text: r.name }), el('b', { text: r.total ? `${fmtSize(r.total - r.free)} / ${fmtSize(r.total)}` : '-' })),
          el('div', { class: 'bar' }, el('i', { style: { width: r.total ? ((r.total - r.free) / r.total * 100) + '%' : 0 } }))))),
      Auth.pinRequired ? el('button', { class: 'btn', onclick: () => Auth.logout() }, icon('logout'), 'ออกจากระบบ') : null);
  };
  render();
  const t = setInterval(render, 5000);
  return { destroy() { clearInterval(t); } };
}

function Help(body) {
  body.append(el('div', { class: 'pane help', html: `
    <h2>วิธีใช้ NexShare</h2>
    <ol>
      <li>เปิดแอป <b>NexShare</b> บนมือถือ แล้วกด <b>เริ่มแชร์</b> (ครั้งแรกต้องอนุญาตให้เข้าถึงไฟล์ทั้งหมด)</li>
      <li>ให้คอมหรือมือถืออีกเครื่องต่อ Wi-Fi เดียวกัน (หรือต่อ Hotspot ของมือถือเครื่องนี้)</li>
      <li>เปิดเบราว์เซอร์ไปที่ <b class="mono">http://nexshare.local:8080</b> ถ้าเข้าไม่ได้ให้ใช้ลิงก์เลข IP ที่แสดงในแอป</li>
      <li>ใส่ PIN 6 หลักที่แสดงในแอป</li>
    </ol>
    <h3>File Station</h3>
    <ul>
      <li>ดับเบิลคลิกเพื่อเปิดโฟลเดอร์หรือดูไฟล์ (บนจอสัมผัสแตะครั้งเดียว)</li>
      <li>ลากไฟล์หรือโฟลเดอร์จากคอมมาวางในหน้าต่างเพื่ออัปโหลด</li>
      <li>เลือกหลายไฟล์ด้วย Ctrl/Shift หรือติ๊กช่องหน้าไฟล์ แล้วกด ดาวน์โหลด (หลายไฟล์จะรวมเป็น ZIP)</li>
      <li>คลิกขวาเพื่อ เปลี่ยนชื่อ / คัดลอก / ตัด / วาง / ลบ · ปุ่มลัด: Delete, F2, Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+V</li>
    </ul>
    <h3>ถ้าเข้า nexshare.local ไม่ได้</h3>
    <ul>
      <li>Windows 10/11, macOS, iPhone และ Linux ส่วนใหญ่รองรับชื่อ .local อยู่แล้ว ส่วน Android บางรุ่นยังไม่รองรับ ให้ใช้ลิงก์ IP แทน</li>
      <li>Wi-Fi สาธารณะหรือเราเตอร์ที่เปิด AP/Client isolation จะกันไม่ให้เครื่องคุยกันได้</li>
    </ul>` }));
}

// ---------------------------------------------------------------- viewer

const Viewer = {
  open(entry, list) {
    this.list = list && list.length ? list : [entry];
    this.i = Math.max(0, this.list.findIndex(e => e.path === entry.path));
    if (!this.el) this.build();
    this.el.classList.remove('hidden');
    this.show();
  },
  build() {
    this.title = el('div', { class: 'v-title' });
    this.body = el('div', { class: 'v-body' });
    this.prev = el('button', { class: 'v-nav prev', onclick: () => this.step(-1) }, icon('back'));
    this.next = el('button', { class: 'v-nav next', onclick: () => this.step(1) }, icon('fwd'));
    this.el = el('div', { id: 'viewer', class: 'hidden' },
      el('div', { class: 'v-top' }, this.title,
        el('button', { title: 'เปิดในแท็บใหม่', onclick: () => window.open(fileUrl(this.cur.path), '_blank') }, icon('open')),
        el('button', { title: 'ดาวน์โหลด', onclick: () => { location.href = fileUrl(this.cur.path, true); } }, icon('download')),
        el('button', { title: 'ปิด', onclick: () => this.close() }, icon('x'))),
      el('div', { style: { flex: 1, minHeight: 0, position: 'relative', display: 'flex' } }, this.body, this.prev, this.next));
    this.body.style.flex = '1';
    document.body.append(this.el);
    addEventListener('keydown', e => {
      if (this.el.classList.contains('hidden') || $('#modal')) return;
      if (e.key === 'Escape') this.close();
      if (e.key === 'ArrowLeft') this.step(-1);
      if (e.key === 'ArrowRight') this.step(1);
    });
    let sx = null;
    this.body.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    this.body.addEventListener('touchend', e => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 60 && kindOf(this.cur) === 'image') this.step(dx < 0 ? 1 : -1);
      sx = null;
    });
  },
  step(d) {
    const n = this.i + d;
    if (n < 0 || n >= this.list.length) return;
    this.i = n;
    this.show();
  },
  async show() {
    const e = this.cur = this.list[this.i];
    this.title.textContent = `${e.name}  ·  ${fmtSize(e.size)}` + (this.list.length > 1 ? `  ·  ${this.i + 1}/${this.list.length}` : '');
    this.prev.classList.toggle('hidden', this.i === 0);
    this.next.classList.toggle('hidden', this.i >= this.list.length - 1);
    const url = fileUrl(e.path);
    const k = kindOf(e);
    this.body.replaceChildren();
    if (k === 'image') this.body.append(el('img', { src: url, alt: e.name }));
    else if (k === 'video') this.body.append(el('video', { src: url, controls: true, autoplay: true, playsinline: true }));
    else if (k === 'audio') this.body.append(el('div', { class: 'v-info' }, fileIcon('audio'), el('audio', { src: url, controls: true, autoplay: true })));
    else if (k === 'pdf') this.body.append(el('iframe', { src: url }));
    else if (k === 'text' && e.size < 4 * 1024 * 1024) {
      const pre = el('pre', { text: 'กำลังโหลด…' });
      this.body.append(pre);
      try {
        const r = await fetch(url, { headers: { Range: 'bytes=0-1048575' } });
        pre.textContent = await r.text();
      } catch { pre.textContent = 'โหลดไม่สำเร็จ'; }
    } else {
      this.body.append(el('div', { class: 'v-info' }, fileIcon(k), el('div', { text: 'ไม่มีตัวอย่างสำหรับไฟล์ชนิดนี้' }),
        el('div', { style: { margin: '6px 0 16px' }, text: `${fmtSize(e.size)} · แก้ไข ${fmtDate(e.mtime)}` }),
        el('a', { class: 'btn primary', href: fileUrl(e.path, true), style: { textDecoration: 'none' } }, icon('download'), 'ดาวน์โหลด')));
    }
  },
  close() {
    this.el.classList.add('hidden');
    this.body.replaceChildren();
  },
};

// ---------------------------------------------------------------- uploads

const Uploader = {
  queue: [], active: 0, listeners: new Set(),
  add(items, dest) {
    if (!items.length || !dest) return;
    $('#uploads').classList.remove('hidden');
    for (const it of items) {
      const bar = el('i');
      const s = el('span', { class: 's', text: 'รอคิว' });
      const node = el('div', { class: 'u-item' }, el('div', { class: 'r1' }, el('span', { class: 'n', text: (it.rel ? it.rel + '/' : '') + it.file.name, title: it.file.name }), s), el('div', { class: 'bar' }, bar));
      $('#uList').prepend(node);
      this.queue.push({ ...it, dest, node, bar, s });
    }
    this.pump();
    this.badge();
  },
  pump() {
    while (this.active < 2 && this.queue.length) this.send(this.queue.shift());
  },
  send(job) {
    this.active++;
    this.badge();
    const xhr = new XMLHttpRequest();
    const t0 = performance.now();
    xhr.open('POST', '/api/upload' + qs({ path: job.dest, name: job.file.name, rel: job.rel || null, mtime: job.file.lastModified || null }));
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const pct = e.loaded / e.total * 100;
      job.bar.style.width = pct + '%';
      const secs = (performance.now() - t0) / 1000;
      job.s.textContent = `${pct.toFixed(0)}% · ${fmtRate(e.loaded / Math.max(secs, .1))}`;
    };
    xhr.onload = () => {
      const ok = xhr.status === 200;
      job.node.classList.add(ok ? 'done' : 'err');
      job.bar.style.width = '100%';
      job.s.textContent = ok ? fmtSize(job.file.size) + ' ✓' : 'ล้มเหลว';
      if (xhr.status === 401) Auth.show();
      this.finish(job, ok);
    };
    xhr.onerror = () => {
      job.node.classList.add('err');
      job.s.textContent = 'การเชื่อมต่อหลุด';
      this.finish(job, false);
    };
    xhr.send(job.file);
  },
  finish(job, ok) {
    this.active--;
    const dest = job.rel ? job.dest + '/' + job.rel : job.dest;
    clearTimeout(this.refreshT);
    this.refreshT = setTimeout(() => this.listeners.forEach(f => f(job.dest)), 300);
    if (!this.active && !this.queue.length) {
      const done = $('#uList').querySelectorAll('.u-item.done').length;
      notify(`อัปโหลดเสร็จ ${done} ไฟล์ไปที่ ${displayPath(dest)}`);
      toast(ok ? 'อัปโหลดเสร็จแล้ว' : 'อัปโหลดเสร็จ (มีบางไฟล์ล้มเหลว)');
    }
    this.pump();
    this.badge();
  },
  badge() {
    const n = this.active + this.queue.length;
    const b = $('#uploadsBadge');
    b.textContent = n;
    b.classList.toggle('hidden', !n);
    $('#uTitle').textContent = n ? `กำลังอัปโหลด (${n})` : 'อัปโหลด';
  },
};
$('#uClose').onclick = () => $('#uploads').classList.add('hidden');
$('#uClear').onclick = () => $('#uList').querySelectorAll('.u-item.done, .u-item.err').forEach(n => n.remove());
$('#uploadsBtn').onclick = () => $('#uploads').classList.toggle('hidden');

// ---------------------------------------------------------------- widgets & polling

function setBar(id, pct) {
  const b = $('#' + id);
  b.style.width = Math.max(0, Math.min(100, pct)) + '%';
  b.parentElement.classList.toggle('warn', pct >= 75 && pct < 90);
  b.parentElement.classList.toggle('crit', pct >= 90);
}

async function poll() {
  try {
    const s = await api('system');
    const H = Stats.hist;
    if (Stats.last) {
      const dt = Math.max(.5, (s.time - Stats.last.time) / 1000);
      Stats.up = Math.max(0, (s.tx - Stats.last.tx) / dt);
      Stats.down = Math.max(0, (s.rx - Stats.last.rx) / dt);
    } else { Stats.up = Stats.down = 0; }
    const ram = (s.memTotal - s.memAvail) / s.memTotal * 100;
    const push = (a, v) => { a.push(v); if (a.length > 60) a.shift(); };
    push(H.cpu, Math.max(0, s.cpu));
    push(H.ram, ram);
    push(H.up, Stats.up);
    push(H.down, Stats.down);
    Stats.last = s;

    $('#serverName').textContent = s.name;
    $('#hName').textContent = s.name;
    $('#hIp').textContent = s.ip || '-';
    $('#hHost').textContent = s.host + ':' + s.port;
    $('#hUp').textContent = fmtUptime(s.uptime);
    const warn = (s.battery >= 0 && s.battery <= 15 && !s.charging) || s.diskFree / s.diskTotal < .05;
    $('#hState').textContent = warn ? 'Warning' : 'Good';
    $('#hState').style.color = warn ? '#e8742a' : '';
    $('#hSub').textContent = warn ? (s.diskFree / s.diskTotal < .05 ? 'พื้นที่เก็บข้อมูลใกล้เต็ม' : 'แบตเตอรี่ใกล้หมด') : 'มือถือของคุณทำงานปกติ';
    $('#rCpu').textContent = s.cpu >= 0 ? s.cpu.toFixed(0) + '%' : 'N/A';
    setBar('rCpuBar', Math.max(0, s.cpu));
    $('#rRam').textContent = ram.toFixed(0) + '%';
    setBar('rRamBar', ram);
    $('#rUp').textContent = fmtRate(Stats.up);
    $('#rDown').textContent = fmtRate(Stats.down);
    drawChart($('#rChart'), [{ data: H.cpu, color: '#1e9ad6' }, { data: H.ram, color: '#2fb36b' }], 100, true);
    const used = s.diskTotal - s.diskFree;
    $('#sPct').textContent = (used / s.diskTotal * 100).toFixed(0) + '%';
    setBar('sBar', used / s.diskTotal * 100);
    $('#sUsed').textContent = fmtSize(used) + ' / ' + fmtSize(s.diskTotal);
    $('#sFree').textContent = fmtSize(s.diskFree);
    $('#sBat').textContent = s.battery >= 0 ? s.battery + '%' + (s.charging ? ' ⚡ กำลังชาร์จ' : '') : '-';
    Stats.listeners.forEach(f => f(s));
  } catch { /* server unreachable or logged out */ }
}

function initWidgets() {
  const panel = $('#widgets'), btn = $('#widgetsBtn'), pin = $('#wPin');
  const hiddenW = new Set(store.get('hiddenWidgets', []));
  const apply = () => {
    const show = store.get('widgets', true);
    panel.classList.toggle('hidden', !show);
    btn.classList.toggle('active', show);
    const pinned = store.get('pinned', false);
    pin.classList.toggle('on', pinned);
    panel.style.zIndex = pinned ? 4500 : 50;
    for (const id of ['wHealth', 'wRes', 'wStorage']) $('#' + id).classList.toggle('hidden', hiddenW.has(id));
  };
  btn.onclick = () => { store.set('widgets', !store.get('widgets', true)); apply(); };
  $('#wMin').onclick = () => { store.set('widgets', false); apply(); };
  pin.onclick = () => { store.set('pinned', !store.get('pinned', false)); apply(); };
  $('#wAdd').onclick = e => menuAt(e.currentTarget, [['wHealth', 'System Health'], ['wRes', 'Resource Monitor'], ['wStorage', 'Storage']].map(([id, label]) => ({
    label: (hiddenW.has(id) ? '☐ ' : '☑ ') + label,
    run: () => { hiddenW.has(id) ? hiddenW.delete(id) : hiddenW.add(id); store.set('hiddenWidgets', [...hiddenW]); apply(); },
  })));
  apply();
}

// ---------------------------------------------------------------- Download Station

const DL_STATUS = { queued: 'รอคิว', downloading: 'กำลังโหลด', paused: 'หยุดชั่วคราว', done: 'เสร็จแล้ว', seeding: 'กำลังแชร์ (seed)', error: 'ผิดพลาด', checking: 'กำลังตรวจสอบ', metadata: 'กำลังหาข้อมูล torrent' };

function fmtEta(secs) {
  if (!isFinite(secs) || secs <= 0) return '';
  if (secs < 60) return Math.ceil(secs) + ' วิ';
  if (secs < 3600) return Math.ceil(secs / 60) + ' นาที';
  return (secs / 3600).toFixed(1) + ' ชม.';
}

function addDownloadDialog(info, preset) {
  return new Promise(resolve => {
    const urls = el('textarea', { placeholder: 'https://example.com/file.zip\nmagnet:?xt=urn:btih:...', spellcheck: 'false' });
    if (preset) urls.value = preset;
    const dest = el('input', { value: info.defaultDir || '', spellcheck: 'false' });
    let torrentFile = null;
    const tName = el('span', { class: 'hint' });
    const tPick = el('input', { type: 'file', accept: '.torrent,application/x-bittorrent', class: 'hidden', onchange: () => {
      torrentFile = tPick.files[0] || null;
      tName.textContent = torrentFile ? ' ' + torrentFile.name : '';
    } });
    const close = v => { wrap.remove(); resolve(v); };
    const wrap = el('div', { id: 'modal', onmousedown: e => { if (e.target === wrap) close(null); } },
      el('div', { class: 'dialog wide' },
        el('div', { class: 'd-head', text: 'สร้างงานดาวน์โหลด' }),
        el('div', { class: 'd-body' },
          el('label', { class: 'f', text: 'ลิงก์ (ใส่ได้หลายบรรทัด) — http, https หรือ magnet' }), urls,
          info.torrent ? el('div', { style: { marginTop: '10px' } },
            el('button', { class: 'btn', onclick: () => tPick.click() }, icon('upload'), 'เลือกไฟล์ .torrent'), tName, tPick)
            : el('div', { class: 'hint', text: 'แอปเวอร์ชันนี้ยังไม่รองรับ BitTorrent' }),
          el('label', { class: 'f', text: 'บันทึกไปที่โฟลเดอร์ (บนมือถือ)' }), dest,
          el('div', { class: 'hint', text: 'มือถือจะโหลดเองแม้ปิดหน้าเว็บนี้ไปแล้ว' })),
        el('div', { class: 'd-foot' },
          el('button', { class: 'btn', text: 'ยกเลิก', onclick: () => close(null) }),
          el('button', { class: 'btn primary', text: 'เริ่มดาวน์โหลด', onclick: () => close({ urls: urls.value, dest: dest.value.trim(), torrentFile }) }))));
    document.body.append(wrap);
    urls.focus();
  });
}

async function submitDownloads(v) {
  if (!v) return false;
  let ok = false;
  try {
    if (v.urls.trim()) { const r = await api('dl/add', null, { method: 'POST', body: JSON.stringify({ urls: v.urls, dest: v.dest }) }); toast(`เพิ่มงานแล้ว ${r.added} รายการ`); ok = true; }
    if (v.torrentFile) {
      const r = await fetch('/api/dl/torrent' + qs({ dest: v.dest || null }), { method: 'POST', body: v.torrentFile });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status);
      toast('เพิ่มไฟล์ torrent แล้ว');
      ok = true;
    }
  } catch (e) { toast('เพิ่มงานไม่สำเร็จ: ' + e.message, 4000); }
  return ok;
}

function DownloadStation(body, win) {
  const st = { filter: 'all', tasks: [], info: {}, sel: new Set() };
  const side = el('div', { class: 'ds-side' });
  const tbody = el('tbody');
  const empty = el('div', { class: 'empty hidden' }, fileIcon('folder'), 'ยังไม่มีงานดาวน์โหลด — กด "สร้าง" แล้ววางลิงก์หรือ magnet');
  const btn = (ico, label, run, cls) => el('button', { class: 'btn ' + (cls || ''), onclick: run }, icon(ico), el('span', { class: cls === 'primary' ? null : 'hide-sm', text: label }));
  const tools = el('div', { class: 'ds-tools' },
    btn('plus', 'สร้าง', () => create(), 'primary'),
    btn('play', 'ดำเนินการต่อ', () => act('resume')),
    btn('min', 'หยุดชั่วคราว', () => act('pause')),
    btn('trash', 'ลบงาน', () => removeSel()),
    el('div', { style: { flex: 1 } }),
    btn('folderUp', 'เปิดโฟลเดอร์', () => openFolder()),
    btn('x', 'ล้างงานที่เสร็จ', async () => { await api('dl/clear', null, { method: 'POST' }); refresh(); }));
  const table = el('table', { class: 'files dl' },
    el('colgroup', null, el('col', { style: { width: '36px' } }), el('col'), el('col', { style: { width: '90px' } }), el('col', { style: { width: '170px' } }), el('col', { class: 'col-type', style: { width: '120px' } }), el('col', { class: 'col-date', style: { width: '140px' } })),
    el('thead', null, el('tr', null, el('th', { class: 'chk' }), el('th', { text: 'ชื่อไฟล์' }), el('th', { text: 'ขนาด' }), el('th', { text: 'ความคืบหน้า' }), el('th', { class: 'col-type', text: 'ความเร็ว' }), el('th', { class: 'col-date', text: 'สถานะ' }))),
    tbody);
  body.append(el('div', { class: 'ds' }, side, el('div', { class: 'ds-main' }, tools, el('div', { class: 'ds-list' }, table, empty))));

  const FILTERS = [['all', 'ทั้งหมด'], ['active', 'กำลังโหลด'], ['done', 'เสร็จแล้ว'], ['paused', 'หยุดชั่วคราว'], ['error', 'ผิดพลาด']];
  const match = (t, f) => f === 'all' || (f === 'active' ? ['downloading', 'queued', 'checking', 'metadata', 'seeding'].includes(t.status) : t.status === f);

  function render() {
    side.replaceChildren(...FILTERS.map(([k, label]) => el('div', { class: 'tn' + (st.filter === k ? ' cur' : ''), onclick: () => { st.filter = k; render(); } },
      el('span', { text: label }), el('span', { class: 'cnt', text: st.tasks.filter(t => match(t, k)).length || '' }))));
    const shown = st.tasks.filter(t => match(t, st.filter));
    empty.classList.toggle('hidden', shown.length > 0);
    table.classList.toggle('hidden', !shown.length);
    tbody.replaceChildren(...shown.map(t => {
      const pct = t.total > 0 ? Math.min(100, t.done / t.total * 100) : (t.status === 'done' ? 100 : 0);
      const eta = t.status === 'downloading' && t.speed > 0 && t.total > 0 ? fmtEta((t.total - t.done) / t.speed) : '';
      const speed = t.status === 'downloading' || t.status === 'seeding'
        ? '▼ ' + fmtRate(t.speed) + (t.type === 'torrent' ? '\n▲ ' + fmtRate(t.upSpeed) : '') : '';
      const chk = el('input', { type: 'checkbox', checked: st.sel.has(t.id), onclick: e => { e.stopPropagation(); e.target.checked ? st.sel.add(t.id) : st.sel.delete(t.id); } });
      const tr = el('tr', { class: 'st-' + t.status + (st.sel.has(t.id) ? ' sel' : ''), title: t.error || t.url,
        onclick: () => { st.sel.clear(); st.sel.add(t.id); render(); },
        ondblclick: () => openTask(t),
        oncontextmenu: e => { e.preventDefault(); if (!st.sel.has(t.id)) { st.sel.clear(); st.sel.add(t.id); render(); } menu(taskMenu(t), e.clientX, e.clientY); } },
        el('td', { class: 'chk' }, chk),
        el('td', { class: 'name' }, el('div', null, fileIcon(t.type === 'torrent' ? 'archive' : kindOf({ name: t.name })), el('span', { text: t.name }))),
        el('td', { class: 'dim', text: t.total > 0 ? fmtSize(t.total) : '-' }),
        el('td', { class: 'prog' }, el('div', { class: 'pct', text: `${pct.toFixed(1)}%${eta ? ' · เหลือ ' + eta : ''}${t.type === 'torrent' && t.peers ? ' · ' + t.peers + ' peers' : ''}` }), el('div', { class: 'bar' }, el('i', { style: { width: pct + '%' } }))),
        el('td', { class: 'dim col-type', style: { whiteSpace: 'pre', lineHeight: '1.3', fontSize: '12px' }, text: speed }),
        el('td', { class: 'col-date' }, el('span', { class: 'st-pill ' + t.status, text: t.status === 'error' ? 'ผิดพลาด: ' + (t.error || '') : (DL_STATUS[t.status] || t.status) })));
      return tr;
    }));
    const active = st.tasks.filter(t => t.status === 'downloading').length;
    win.setTitle('Download Station' + (active ? ` — กำลังโหลด ${active}` : ''));
  }

  function taskMenu(t) {
    return [
      { label: 'เปิดไฟล์', ico: 'open', disabled: t.status !== 'done' && t.status !== 'seeding', run: () => openTask(t) },
      { label: 'เปิดโฟลเดอร์ปลายทาง', ico: 'folderUp', run: () => openApp('filestation', { path: t.dest }) },
      { label: 'คัดลอกลิงก์ต้นทาง', ico: 'link', run: () => dialog({ title: 'ลิงก์ต้นทาง', input: t.url, cancel: false }) },
      '-',
      { label: 'ดำเนินการต่อ', ico: 'play', disabled: !['paused', 'error'].includes(t.status), run: () => act('resume') },
      { label: 'หยุดชั่วคราว', ico: 'min', disabled: !['downloading', 'queued', 'seeding', 'metadata'].includes(t.status), run: () => act('pause') },
      { label: 'ลบงาน', ico: 'trash', danger: true, run: removeSel },
    ];
  }
  async function openTask(t) {
    if (t.status !== 'done' && t.status !== 'seeding') return;
    const path = t.dest + '/' + t.name;
    try {
      const r = await api('list', { path: t.dest });
      const e = r.entries.find(x => x.path === path);
      if (!e) return toast('ไม่พบไฟล์');
      if (e.dir) return openApp('filestation', { path });
      openEntry(e, r.entries.filter(x => !x.dir));
    } catch (e) { toast('เปิดไม่ได้: ' + e.message); }
  }
  async function act(kind) {
    for (const id of st.sel) await api('dl/' + kind, { id }, { method: 'POST' }).catch(() => {});
    refresh();
  }
  async function removeSel() {
    if (!st.sel.size) return;
    const files = el('input', { type: 'checkbox' });
    const ok = await new Promise(resolve => {
      const close = v => { wrap.remove(); resolve(v); };
      const wrap = el('div', { id: 'modal' }, el('div', { class: 'dialog' },
        el('div', { class: 'd-head', text: `ลบ ${st.sel.size} งาน?` }),
        el('div', { class: 'd-body' }, el('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' } }, files, 'ลบไฟล์ที่โหลดมาแล้วด้วย')),
        el('div', { class: 'd-foot' }, el('button', { class: 'btn', text: 'ยกเลิก', onclick: () => close(false) }), el('button', { class: 'btn danger', text: 'ลบ', onclick: () => close(true) }))));
      document.body.append(wrap);
    });
    if (!ok) return;
    for (const id of st.sel) await api('dl/remove', { id, files: files.checked ? 1 : 0 }, { method: 'POST' }).catch(() => {});
    st.sel.clear();
    refresh();
  }
  function openFolder() {
    const t = st.tasks.find(x => st.sel.has(x.id));
    openApp('filestation', { path: t ? t.dest : st.info.defaultDir });
  }
  async function create(preset) {
    const v = await addDownloadDialog(st.info, preset);
    if (await submitDownloads(v)) refresh();
  }
  async function refresh() {
    try {
      const r = await api('dl/list');
      st.tasks = r.tasks;
      st.info = { defaultDir: r.defaultDir, torrent: r.torrent };
      for (const id of [...st.sel]) if (!st.tasks.some(t => t.id === id)) st.sel.delete(id);
      render();
    } catch { /* offline */ }
  }
  refresh();
  const timer = setInterval(refresh, 1500);
  return { destroy() { clearInterval(timer); }, handle(arg) { if (arg.add) create(arg.add); } };
}

// ---------------------------------------------------------------- Media Player

function srtToVtt(text) {
  return 'WEBVTT\n\n' + text.replace(/\r/g, '').replace(/^\d+\s*$/gm, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2').trim() + '\n';
}
const fmtClock = s => {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

function MediaPlayer(body, win) {
  const st = { list: [], i: -1, folder: [], shuffle: false, loop: store.get('mp.loop', 'list'), subUrl: null, subs: [] };
  const video = el('video', { playsinline: true, preload: 'metadata' });
  video.volume = store.get('mp.vol', 1);
  const art = el('div', { class: 'mp-art hidden' }, el('div', null, el('div', { class: 'disc' }), el('div', { class: 't' }), el('div', { class: 's' })));
  const osd = el('div', { class: 'mp-osd', style: { opacity: 0 } });
  const big = el('div', { class: 'mp-big', style: { opacity: 0 } });
  const msg = el('div', { class: 'mp-msg hidden' });
  const screen = el('div', { class: 'mp-screen' }, video, art, big, osd, msg);

  const played = el('div', { class: 'played' }), buf = el('div', { class: 'buf' }), knob = el('div', { class: 'knob' }), tip = el('div', { class: 'tip' });
  const seek = el('div', { class: 'mp-seek' }, el('div', { class: 'track' }), buf, played, knob, tip);
  const time = el('span', { class: 'time', text: '0:00 / 0:00' });
  const b = (ico, title, run) => el('button', { title, onclick: run }, typeof ico === 'string' ? icon(ico) : ico);
  const playBtn = b('play', 'เล่น/หยุด (Space)', () => toggle());
  const vol = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: video.volume, class: 'vol', oninput: e => { video.volume = +e.target.value; video.muted = false; store.set('mp.vol', video.volume); } });
  const muteBtn = b(volIcon(), 'ปิดเสียง (M)', () => { video.muted = !video.muted; });
  const speedBtn = el('button', { title: 'ความเร็ว', text: '1x', onclick: e => menuAt(e.currentTarget, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => ({ label: (video.playbackRate === r ? '● ' : '') + r + 'x', run: () => setRate(r) }))) });
  const ccBtn = el('button', { title: 'คำบรรยาย', text: 'CC', onclick: e => subMenu(e.currentTarget) });
  const loopBtn = b('refresh', 'เล่นซ้ำ', () => cycleLoop());
  const shufBtn = el('button', { title: 'สุ่ม', text: '⤮', style: { fontSize: '17px' }, onclick: () => { st.shuffle = !st.shuffle; shufBtn.classList.toggle('on', st.shuffle); flash(st.shuffle ? 'สุ่มเพลง: เปิด' : 'สุ่มเพลง: ปิด'); } });
  const listBtn = b('list', 'เพลย์ลิสต์', () => { listPane.classList.toggle('hidden'); listBtn.classList.toggle('on', !listPane.classList.contains('hidden')); });
  listBtn.classList.add('on');
  const more = b('link', 'ลิงก์สตรีม / เปิดใน VLC', e => menuAt(e.currentTarget, [
    { label: 'คัดลอกลิงก์สตรีม (ใช้กับ VLC/โปรแกรมอื่น)', ico: 'link', run: () => copyStream() },
    { label: 'เปิดในแอป VLC (มือถือ)', ico: 'open', run: () => { location.href = 'vlc://' + location.origin + fileUrl(cur().path); } },
    { label: 'ดาวน์โหลดไฟล์นี้', ico: 'download', run: () => { location.href = fileUrl(cur().path, true); } },
    document.pictureInPictureEnabled ? { label: 'ภาพซ้อนภาพ (PiP)', ico: 'restore', run: () => video.requestPictureInPicture().catch(() => {}) } : null,
  ]));
  const fsBtn = b('max', 'เต็มจอ (F)', () => fullscreen());
  const ctrl = el('div', { class: 'mp-ctrl' }, seek, el('div', { class: 'mp-row' },
    b('back', 'ก่อนหน้า (P)', () => step(-1)), playBtn, b('fwd', 'ถัดไป (N)', () => step(1)),
    time, el('div', { class: 'grow' }), muteBtn, vol, speedBtn, ccBtn, loopBtn, shufBtn, more, listBtn, fsBtn));
  const stage = el('div', { class: 'mp-stage' }, screen, ctrl);
  const listItems = el('div', { class: 'items' });
  const listHead = el('h4');
  const listPane = el('div', { class: 'mp-list' }, listHead, listItems);
  const root = el('div', { class: 'mp', tabindex: '0' }, stage, listPane);
  body.append(root);
  updateLoopBtn();

  function volIcon() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round');
    s.innerHTML = '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path class="w" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>';
    return s;
  }
  const cur = () => st.list[st.i];
  const isAudio = e => kindOf(e) === 'audio';

  function flash(text) {
    osd.textContent = text;
    osd.style.opacity = 1;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { osd.style.opacity = 0; }, 900);
  }
  function bigIcon(name) {
    big.replaceChildren(icon(name));
    big.style.opacity = 1;
    clearTimeout(bigIcon.t);
    bigIcon.t = setTimeout(() => { big.style.opacity = 0; }, 450);
  }
  function setRate(r) { video.playbackRate = r; speedBtn.textContent = r + 'x'; flash('ความเร็ว ' + r + 'x'); }
  function cycleLoop() {
    st.loop = { list: 'one', one: 'off', off: 'list' }[st.loop];
    store.set('mp.loop', st.loop);
    updateLoopBtn();
    flash({ list: 'เล่นซ้ำทั้งเพลย์ลิสต์', one: 'เล่นซ้ำไฟล์นี้', off: 'ไม่เล่นซ้ำ' }[st.loop]);
  }
  function updateLoopBtn() {
    loopBtn.classList.toggle('on', st.loop !== 'off');
    loopBtn.title = { list: 'เล่นซ้ำ: ทั้งหมด', one: 'เล่นซ้ำ: ไฟล์นี้', off: 'เล่นซ้ำ: ปิด' }[st.loop];
    loopBtn.style.position = 'relative';
    loopBtn.dataset.one = st.loop === 'one' ? '1' : '';
    loopBtn.replaceChildren(icon('refresh'), st.loop === 'one' ? el('span', { text: '1', style: { position: 'absolute', fontSize: '9px', right: '6px', bottom: '5px' } }) : '');
  }
  function toggle() { if (video.paused) video.play().catch(() => {}); else video.pause(); }
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else (stage.requestFullscreen ? stage.requestFullscreen() : video.webkitEnterFullscreen && video.webkitEnterFullscreen());
  }
  function copyStream() {
    const url = location.origin + fileUrl(cur().path);
    if (navigator.clipboard && isSecureContext) navigator.clipboard.writeText(url).then(() => toast('คัดลอกลิงก์แล้ว'));
    else dialog({ title: 'ลิงก์สตรีม — วางใน VLC (Media › Open Network Stream)', input: url, cancel: false });
  }

  function savePos() {
    const e = cur();
    if (!e || !isFinite(video.duration) || video.duration < 120) return;
    const pos = video.currentTime > 10 && video.currentTime < video.duration - 15 ? Math.floor(video.currentTime) : 0;
    const all = store.get('mp.pos', {});
    if (pos) all[e.path] = pos; else delete all[e.path];
    const keys = Object.keys(all);
    if (keys.length > 200) delete all[keys[0]];
    store.set('mp.pos', all);
  }

  async function play(i, resume = true) {
    savePos();
    st.i = i;
    const e = cur();
    if (!e) return;
    msg.classList.add('hidden');
    [...video.querySelectorAll('track')].forEach(t => t.remove());
    if (st.subUrl) { URL.revokeObjectURL(st.subUrl); st.subUrl = null; }
    video.src = fileUrl(e.path);
    const audio = isAudio(e);
    art.classList.toggle('hidden', !audio);
    if (audio) { art.querySelector('.t').textContent = e.name.replace(/\.[^.]+$/, ''); art.querySelector('.s').textContent = `${st.i + 1} / ${st.list.length} · ${fmtSize(e.size)}`; }
    win.setTitle('Media Player — ' + e.name);
    const pos = resume && store.get('mp.pos', {})[e.path];
    if (pos) video.addEventListener('loadedmetadata', () => { video.currentTime = pos; flash('เล่นต่อจาก ' + fmtClock(pos)); }, { once: true });
    video.play().catch(() => {});
    renderList();
    findSubs(e);
  }
  function step(d) {
    if (!st.list.length) return;
    let n;
    if (st.shuffle && st.list.length > 1) { do n = Math.floor(Math.random() * st.list.length); while (n === st.i); }
    else n = st.i + d;
    if (n >= st.list.length) { if (st.loop === 'list') n = 0; else return; }
    if (n < 0) n = st.list.length - 1;
    play(n);
  }

  async function findSubs(e) {
    st.subs = [];
    ccBtn.classList.remove('on');
    if (isAudio(e)) return;
    let folder = st.folder;
    const dir = e.path.slice(0, e.path.lastIndexOf('/'));
    if (!folder.length || !folder.some(x => x.path.startsWith(dir + '/'))) {
      try { folder = (await api('list', { path: dir })).entries; st.folder = folder; } catch { folder = []; }
    }
    const base = e.name.replace(/\.[^.]+$/, '').toLowerCase();
    st.subs = folder.filter(x => /\.(srt|vtt)$/i.test(x.name) && x.path.startsWith(dir + '/'))
      .sort((a, b) => (b.name.toLowerCase().startsWith(base)) - (a.name.toLowerCase().startsWith(base)));
    const auto = st.subs.find(x => x.name.toLowerCase().startsWith(base));
    if (auto) loadSub(auto, true);
  }
  async function loadSub(s, quiet) {
    try {
      let text = await (await fetch(fileUrl(s.path))).text();
      if (/\.srt$/i.test(s.name)) text = srtToVtt(text);
      [...video.querySelectorAll('track')].forEach(t => t.remove());
      if (st.subUrl) URL.revokeObjectURL(st.subUrl);
      st.subUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      const tr = el('track', { kind: 'subtitles', src: st.subUrl, srclang: 'th', label: s.name, default: true });
      video.append(tr);
      tr.track.mode = 'showing';
      ccBtn.classList.add('on');
      if (!quiet) flash('คำบรรยาย: ' + s.name);
    } catch { toast('โหลดคำบรรยายไม่ได้'); }
  }
  function subMenu(anchor) {
    const pickLocal = el('input', { type: 'file', accept: '.srt,.vtt', class: 'hidden', onchange: async () => {
      const f = pickLocal.files[0];
      if (!f) return;
      let text = await f.text();
      if (/\.srt$/i.test(f.name)) text = srtToVtt(text);
      [...video.querySelectorAll('track')].forEach(t => t.remove());
      st.subUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      const tr = el('track', { kind: 'subtitles', src: st.subUrl, label: f.name, default: true });
      video.append(tr);
      tr.track.mode = 'showing';
      ccBtn.classList.add('on');
    } });
    document.body.append(pickLocal);
    const track = video.textTracks[0];
    menuAt(anchor, [
      { label: (track && track.mode === 'showing' ? '' : '● ') + 'ปิดคำบรรยาย', run: () => { if (track) track.mode = 'hidden'; ccBtn.classList.remove('on'); } },
      ...st.subs.map(s => ({ label: s.name, run: () => loadSub(s) })),
      '-',
      { label: 'โหลดไฟล์คำบรรยายจากเครื่องนี้…', ico: 'upload', run: () => pickLocal.click() },
    ]);
  }

  function renderList() {
    listHead.replaceChildren(el('span', { text: 'เพลย์ลิสต์', style: { color: '#e6edf3', fontWeight: 600 } }), el('span', { text: st.list.length + ' ไฟล์' }));
    listItems.replaceChildren(...st.list.map((e, i) => {
      const k = kindOf(e);
      let thumb;
      if (k === 'video') { thumb = el('img', { loading: 'lazy', src: thumbUrl(e.path, 160), alt: '' }); thumb.onerror = () => thumb.replaceWith(el('div', { class: 'ph' }, fileIcon(k))); }
      else thumb = el('div', { class: 'ph' }, fileIcon(k));
      return el('div', { class: 'mp-item' + (i === st.i ? ' cur' : ''), onclick: () => play(i) }, thumb,
        el('div', { style: { minWidth: 0 } }, el('div', { class: 'n', text: e.name }), el('div', { class: 'z', text: fmtSize(e.size) })));
    }));
    const c = listItems.children[st.i];
    if (c) c.scrollIntoView({ block: 'nearest' });
  }

  // ---- events
  const updateTime = () => {
    const d = video.duration || 0, t = video.currentTime || 0;
    const p = d ? t / d * 100 : 0;
    played.style.width = p + '%';
    knob.style.left = p + '%';
    time.textContent = fmtClock(t) + ' / ' + fmtClock(d);
    if (video.buffered.length && d) buf.style.width = video.buffered.end(video.buffered.length - 1) / d * 100 + '%';
  };
  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('progress', updateTime);
  video.addEventListener('loadedmetadata', updateTime);
  video.addEventListener('play', () => { playBtn.replaceChildren(icon('pause')); art.classList.add('spin'); });
  video.addEventListener('pause', () => { playBtn.replaceChildren(icon('play')); art.classList.remove('spin'); savePos(); });
  video.addEventListener('volumechange', () => { vol.value = video.muted ? 0 : video.volume; muteBtn.querySelector('.w').style.display = video.muted || !video.volume ? 'none' : ''; });
  video.addEventListener('ended', () => { if (st.loop === 'one') { video.currentTime = 0; video.play(); } else step(1); });
  video.addEventListener('error', () => {
    if (!cur()) return;
    msg.replaceChildren(el('div', null,
      el('div', { style: { fontSize: '15px', marginBottom: '6px' }, text: 'เบราว์เซอร์เล่นไฟล์นี้ไม่ได้' }),
      el('div', { style: { color: '#8b98a5', marginBottom: '14px', fontSize: '12.5px' }, text: 'มักเกิดจาก codec ที่เบราว์เซอร์ไม่รองรับ (เช่น HEVC/H.265, AC3, DTS ในไฟล์ .mkv/.avi) ลองเปิดด้วย VLC แทน' }),
      el('button', { class: 'btn primary', onclick: copyStream }, icon('link'), 'คัดลอกลิงก์ไปเปิดใน VLC'),
      el('a', { class: 'btn', href: 'vlc://' + location.origin + fileUrl(cur().path), style: { textDecoration: 'none' } }, icon('open'), 'เปิดแอป VLC'),
      el('button', { class: 'btn', onclick: () => step(1) }, icon('fwd'), 'ไฟล์ถัดไป')));
    msg.classList.remove('hidden');
  });
  screen.addEventListener('click', e => { if (e.target === video || e.target === screen) { toggle(); bigIcon(video.paused ? 'pause' : 'play'); } });
  screen.addEventListener('dblclick', fullscreen);

  const seekTo = x => { const r = seek.getBoundingClientRect(); const f = Math.min(1, Math.max(0, (x - r.left) / r.width)); if (video.duration) video.currentTime = f * video.duration; };
  seek.addEventListener('pointerdown', e => {
    seekTo(e.clientX);
    const move = ev => seekTo(ev.clientX);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  seek.addEventListener('mousemove', e => {
    const r = seek.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    tip.style.left = f * 100 + '%';
    tip.textContent = fmtClock(f * (video.duration || 0));
  });

  root.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || $('#modal')) return;
    const k = e.key.toLowerCase();
    const seekBy = s => { video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + s)); flash((s > 0 ? '+' : '') + s + ' วิ'); };
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); bigIcon(video.paused ? 'pause' : 'play'); }
    else if (k === 'arrowright') seekBy(5);
    else if (k === 'arrowleft') seekBy(-5);
    else if (k === 'l') seekBy(10);
    else if (k === 'j') seekBy(-10);
    else if (k === 'arrowup') { e.preventDefault(); video.volume = Math.min(1, video.volume + .05); flash('เสียง ' + Math.round(video.volume * 100) + '%'); }
    else if (k === 'arrowdown') { e.preventDefault(); video.volume = Math.max(0, video.volume - .05); flash('เสียง ' + Math.round(video.volume * 100) + '%'); }
    else if (k === 'm') video.muted = !video.muted;
    else if (k === 'f') fullscreen();
    else if (k === 'n') step(1);
    else if (k === 'p') step(-1);
    else if (k === '>' || k === '.') setRate(Math.min(2, video.playbackRate + .25));
    else if (k === '<' || k === ',') setRate(Math.max(.25, video.playbackRate - .25));
    else if (k === 'c') { const t = video.textTracks[0]; if (t) { t.mode = t.mode === 'showing' ? 'hidden' : 'showing'; ccBtn.classList.toggle('on', t.mode === 'showing'); } }
  });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  }

  return {
    handle(arg) {
      const kind = kindOf(arg.entry);
      st.list = (arg.list && arg.list.length ? arg.list : [arg.entry]).filter(x => ['video', 'audio'].includes(kindOf(x)) && (kind === 'audio') === isAudio(x));
      if (!st.list.some(x => x.path === arg.entry.path)) st.list.unshift(arg.entry);
      st.folder = arg.folder || [];
      play(st.list.findIndex(x => x.path === arg.entry.path));
      setTimeout(() => root.focus(), 50);
    },
    destroy() { savePos(); video.pause(); video.removeAttribute('src'); video.load(); if (st.subUrl) URL.revokeObjectURL(st.subUrl); },
  };
}

/** Opens a file in the best app: media → Media Player, everything else → viewer. */
function openEntry(e, siblings, folder) {
  const k = kindOf(e);
  if (k === 'video' || k === 'audio') openApp('player', { entry: e, list: siblings, folder: folder || siblings });
  else Viewer.open(e, siblings);
}

// ---------------------------------------------------------------- Terminal (root)

function Terminal(body, win) {
  const out = el('div', { class: 'term-out' });
  const ps = el('span', { class: 'ps', text: '/data/local/tmp' });
  const input = el('input', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', placeholder: 'พิมพ์คำสั่งแล้ว Enter' });
  const st = { cwd: '/data/local/tmp', history: store.get('term.hist', []), hi: -1, busy: false };
  const quick = ['ls -la', 'busybox | head -40', 'id', 'getprop ro.product.model', 'df -h', 'free -m', 'ps -A | head', 'pm list packages -3'];
  const bar = el('div', { class: 'term-bar' }, ...quick.map(c => el('button', { class: 'term-chip', text: c, onclick: () => run(c) })));
  const inBar = el('div', { class: 'term-in' }, ps, input);
  body.append(el('div', { class: 'term' }, bar, out, inBar));

  function line(text, cls) {
    out.append(el('div', { class: cls || null, text }));
    out.scrollTop = out.scrollHeight;
  }
  function write(text) {
    if (!text) return;
    const pre = el('div');
    pre.textContent = text.replace(/\n$/, '');
    out.append(pre);
    out.scrollTop = out.scrollHeight;
  }

  async function run(cmd) {
    cmd = cmd.trim();
    if (!cmd || st.busy) return;
    if (cmd === 'clear') { out.replaceChildren(); input.value = ''; return; }
    st.history = st.history.filter(h => h !== cmd); st.history.push(cmd);
    if (st.history.length > 100) st.history.shift();
    store.set('term.hist', st.history);
    st.hi = -1;
    line(cmd, 'cmd');
    input.value = '';
    st.busy = true;
    input.disabled = true;
    try {
      const r = await api('root/exec', null, { method: 'POST', body: JSON.stringify({ cmd, cwd: st.cwd }) });
      write(r.output);
      if (r.cwd) { st.cwd = r.cwd; ps.textContent = r.cwd; }
    } catch (e) {
      line(e.message, 'err');
      if (e.status === 401) Auth.show();
    }
    st.busy = false;
    input.disabled = false;
    input.focus();
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') run(input.value);
    else if (e.key === 'ArrowUp') { if (st.hi < st.history.length - 1) { st.hi++; input.value = st.history[st.history.length - 1 - st.hi]; e.preventDefault(); } }
    else if (e.key === 'ArrowDown') { if (st.hi > 0) { st.hi--; input.value = st.history[st.history.length - 1 - st.hi]; } else { st.hi = -1; input.value = ''; } }
    else if (e.key === 'c' && e.ctrlKey) { input.value = ''; line('^C', 'err'); }
  });
  body.addEventListener('click', e => { if (!e.target.closest('button') && !window.getSelection().toString()) input.focus(); });

  (async () => {
    try {
      const s = await api('root/status');
      if (!s.root) {
        out.append(el('div', { class: 'notice', text: s.flavor !== 'root'
          ? 'Terminal ใช้ได้เฉพาะ NexShare รุ่น Root'
          : 'ยังไม่ได้สิทธิ์ root — เปิดแอป NexShare บนมือถือแล้วกด "ขอสิทธิ์ root" (ต้องมี Magisk/SuperSU)' }));
        input.disabled = true;
        return;
      }
      line('NexShare root shell'
        + (s.busybox ? ' · มี busybox (~300 คำสั่ง: ls, grep, sed, awk, tar, vi, wget, top…)' : '')
        + (s.termux ? ' · พบ Termux (ใช้แพ็กเกจของ Termux ได้ด้วย)' : ''));
      run('id && getprop ro.product.model');
      input.focus();
    } catch (e) { out.append(el('div', { class: 'notice', text: e.message })); }
  })();

  return { handle() { input.focus(); } };
}

// ---------------------------------------------------------------- Screen mirror (root)

function ScreenMirror(body, win) {
  const img = el('img', { alt: 'หน้าจอมือถือ', draggable: false });
  const stage = el('div', { class: 'scr-stage' }, el('div', { class: 'scr-msg', text: 'กำลังเชื่อมต่อ…' }));
  const fps = el('span', { class: 'fps', text: '' });
  const liveBtn = el('button', { class: 'btn', onclick: () => toggle() }, icon('play'), el('span', { text: 'เริ่มสด' }));
  const shotBtn = el('button', { class: 'btn', onclick: () => grab() }, icon('refresh'), el('span', { class: 'hide-sm', text: 'ถ่ายใหม่' }));
  const saveBtn = el('button', { class: 'btn', onclick: () => save() }, icon('download'), el('span', { class: 'hide-sm', text: 'บันทึก' }));
  const rateSel = el('select', { onchange: () => { st.interval = +rateSel.value; if (st.live) { stop(); start(); } }, style: { height: '30px', borderRadius: '7px', background: '#1b2330', color: '#d6dee8', border: '1px solid #2a3440' } },
    ...[[700, 'ปกติ ~1.4 fps'], [400, 'เร็ว ~2.5 fps'], [1500, 'ประหยัด'], [250, 'ลื่นสุด (กินแบต)']].map(([v, l]) => el('option', { value: v, text: l })));
  const tapChk = el('label', { style: { color: '#c4cfda', fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } },
    el('input', { type: 'checkbox', checked: true, onchange: e => st.control = e.target.checked }), 'สั่งงาน (แตะ/ปัด)');
  const bar = el('div', { class: 'scr-bar' }, liveBtn, shotBtn, rateSel, tapChk, el('span', { class: 'grow' }), fps, saveBtn);
  const key = (label, code) => el('button', { title: label, onclick: () => sendKey(code) }, label === 'Back' ? icon('back') : label === 'Home' ? el('span', { text: '⬤', style: { fontSize: '12px' } }) : label === 'Recents' ? icon('max') : el('span', { text: label }));
  const nav = el('div', { class: 'scr-nav' }, key('Back', 4), key('Home', 3), key('Recents', 187),
    el('button', { title: 'Power', onclick: () => sendKey(26) }, el('span', { text: '⏻' })),
    el('button', { title: 'Volume +', onclick: () => sendKey(24) }, el('span', { text: '🔊' })),
    el('button', { title: 'Volume −', onclick: () => sendKey(25) }, el('span', { text: '🔈' })));
  body.append(el('div', { class: 'scr' }, bar, stage, nav));

  const st = { live: false, interval: 700, control: true, busy: false, lastShot: null, natW: 0, natH: 0, lastT: 0, timer: null };

  async function grab() {
    if (st.busy) return;
    st.busy = true;
    try {
      const r = await fetch('/api/root/screen?t=' + Date.now(), { credentials: 'same-origin' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) { Auth.show(); stop(); return; }
        throw new Error(j.error || r.status);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (st.lastShot) URL.revokeObjectURL(st.lastShot);
      st.lastShot = url;
      if (!img.parentElement) stage.replaceChildren(img);
      img.src = url;
      const now = performance.now();
      if (st.lastT) fps.textContent = (1000 / (now - st.lastT)).toFixed(1) + ' fps';
      st.lastT = now;
    } catch (e) {
      if (!st.live) stage.replaceChildren(el('div', { class: 'scr-msg', text: 'จับภาพไม่ได้: ' + e.message }));
    }
    st.busy = false;
  }
  function start() {
    st.live = true;
    liveBtn.replaceChildren(icon('pause'), el('span', { text: 'หยุด' }));
    const loop = async () => { if (!st.live) return; await grab(); if (st.live) st.timer = setTimeout(loop, st.interval); };
    loop();
  }
  function stop() {
    st.live = false;
    clearTimeout(st.timer);
    liveBtn.replaceChildren(icon('play'), el('span', { text: 'เริ่มสด' }));
    fps.textContent = '';
  }
  function toggle() { st.live ? stop() : start(); }

  img.addEventListener('load', () => { st.natW = img.naturalWidth; st.natH = img.naturalHeight; });
  function mapCoord(ev) {
    const r = img.getBoundingClientRect();
    return { x: Math.round((ev.clientX - r.left) / r.width * st.natW), y: Math.round((ev.clientY - r.top) / r.height * st.natH) };
  }
  let down = null;
  img.addEventListener('pointerdown', e => { if (st.control) { down = { ...mapCoord(e), t: Date.now() }; e.preventDefault(); } });
  img.addEventListener('pointerup', async e => {
    if (!st.control || !down) return;
    const up = mapCoord(e);
    const dist = Math.hypot(up.x - down.x, up.y - down.y);
    try {
      if (dist < 12 && Date.now() - down.t < 400) await sendInput({ type: 'tap', x: up.x, y: up.y });
      else await sendInput({ type: 'swipe', x1: down.x, y1: down.y, x2: up.x, y2: up.y, ms: Math.min(800, Date.now() - down.t) });
      setTimeout(grab, 120);
    } catch (err) { toast(err.message); }
    down = null;
  });
  async function sendInput(b) { await api('root/input', null, { method: 'POST', body: JSON.stringify(b) }); }
  async function sendKey(code) { try { await sendInput({ type: 'key', key: String(code) }); setTimeout(grab, 150); } catch (e) { toast(e.message); } }
  async function save() {
    if (!st.lastShot) return;
    const a = el('a', { href: st.lastShot, download: 'screen-' + Date.now() + '.png' });
    document.body.append(a); a.click(); a.remove();
  }

  (async () => {
    try {
      const s = await api('root/status');
      if (!s.root) {
        stage.replaceChildren(el('div', { class: 'scr-msg', text: s.flavor !== 'root'
          ? 'ดูหน้าจอได้เฉพาะ NexShare รุ่น Root' : 'ยังไม่ได้สิทธิ์ root — ขอสิทธิ์ในแอปบนมือถือก่อน' }));
        [liveBtn, shotBtn, saveBtn].forEach(b => b.disabled = true);
        return;
      }
      await grab();
      start();
    } catch (e) { stage.replaceChildren(el('div', { class: 'scr-msg', text: e.message })); }
  })();

  return { destroy() { stop(); if (st.lastShot) URL.revokeObjectURL(st.lastShot); } };
}

// ---------------------------------------------------------------- Package Center

function PackageCenter(body, win) {
  const st = { apps: [], root: false, flavor: 'normal', q: '', showSystem: false };
  const search = el('input', { placeholder: 'ค้นหาแอป', oninput: e => { st.q = e.target.value.toLowerCase(); render(); } });
  const sysChk = el('label', { style: { display: 'flex', gap: '5px', alignItems: 'center', fontSize: '12.5px', color: 'var(--text-2)', whiteSpace: 'nowrap' } },
    el('input', { type: 'checkbox', onchange: e => { st.showSystem = e.target.checked; load(); } }), 'รวมแอประบบ');
  const installBtn = el('button', { class: 'btn primary', onclick: () => pick() }, icon('upload'), el('span', { text: 'ติดตั้ง APK' }));
  const bar = el('div', { class: 'pc-bar' }, el('div', { class: 'pc-search' }, icon('search'), search), sysChk, installBtn);
  const drop = el('div', { class: 'pc-drop', text: 'ลากไฟล์ .apk มาวางที่นี่เพื่อติดตั้ง' });
  const list = el('div', { class: 'pc-list' }, drop);
  const apkPick = el('input', { type: 'file', accept: '.apk', class: 'hidden', onchange: () => { if (apkPick.files[0]) installApk(apkPick.files[0]); apkPick.value = ''; } });
  body.append(el('div', { class: 'pc' }, bar, list), apkPick);

  function render() {
    const rows = st.apps.filter(a => !st.q || a.label.toLowerCase().includes(st.q) || a.pkg.includes(st.q));
    win.setTitle('Package Center — ' + st.apps.length + ' แอป');
    list.replaceChildren(drop, ...rows.map(a => {
      const ico = el('img', { loading: 'lazy', src: '/api/root/appicon' + qs({ pkg: a.pkg }), alt: '' });
      ico.onerror = () => ico.replaceWith(el('div', { class: 'ph' }, fileIcon('apk')));
      return el('div', { class: 'pc-item' }, ico,
        el('div', { class: 'meta' },
          el('div', { class: 'nm' }, a.label, a.system ? el('span', { class: 'tag sys', text: ' ระบบ', style: { marginLeft: '6px' } }) : '', !a.enabled ? el('span', { class: 'tag off', text: ' ปิดอยู่', style: { marginLeft: '6px' } }) : ''),
          el('div', { class: 'sub', text: a.pkg + (a.version ? ' · v' + a.version : '') + (a.size ? ' · ' + fmtSize(a.size) : '') })),
        el('button', { class: 'btn', onclick: e => menuAt(e.currentTarget, appMenu(a)) }, 'จัดการ', icon('chev', 'chev')));
    }));
  }
  function appMenu(a) {
    const act = async (action, confirm) => {
      if (confirm && !await dialog({ title: confirm, okText: 'ตกลง', danger: true })) return;
      try { const r = await api('root/app', { pkg: a.pkg, action }, { method: 'POST' }); toast('สำเร็จ'); if (['uninstall', 'disable', 'enable'].includes(action)) load(); }
      catch (e) { toast('ไม่สำเร็จ: ' + e.message); }
    };
    return [
      { label: 'เปิดแอป', ico: 'open', run: () => act('open') },
      st.root ? { label: 'บังคับหยุด', ico: 'min', run: () => act('force-stop') } : null,
      st.root ? { label: 'ล้างข้อมูล', ico: 'trash', run: () => act('clear', 'ล้างข้อมูลของ ' + a.label + '?') } : null,
      st.root && a.enabled && a.system ? { label: 'ปิดการใช้งาน', run: () => act('disable', 'ปิด ' + a.label + '?') } : null,
      st.root && !a.enabled ? { label: 'เปิดการใช้งาน', run: () => act('enable') } : null,
      st.root && !a.system ? { label: 'ถอนการติดตั้ง', ico: 'trash', danger: true, run: () => act('uninstall', 'ถอน ' + a.label + '?') } : null,
    ].filter(Boolean);
  }
  function pick() { apkPick.click(); }
  async function installApk(file) {
    toast('กำลังอัปโหลดและติดตั้ง ' + file.name + '…', 4000);
    try {
      const r = await fetch('/api/root/install', { method: 'POST', body: file, credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status);
      if (j.mode === 'root') { toast('ติดตั้งสำเร็จ'); load(); }
      else toast('อัปโหลดแล้ว — ยืนยันการติดตั้งบนหน้าจอมือถือ', 5000);
    } catch (e) { toast('ติดตั้งไม่สำเร็จ: ' + e.message, 5000); }
  }
  let dragN = 0;
  list.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dragN++; drop.classList.add('drag'); } });
  list.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; drop.classList.remove('drag'); } });
  list.addEventListener('dragover', e => e.preventDefault());
  list.addEventListener('drop', e => { e.preventDefault(); dragN = 0; drop.classList.remove('drag'); const f = [...e.dataTransfer.files].find(f => /\.apk$/i.test(f.name)); if (f) installApk(f); else toast('ลากไฟล์ .apk เท่านั้น'); });

  async function load() {
    try {
      const r = await api('root/apps', { system: st.showSystem ? 1 : 0 });
      st.apps = r.apps;
      st.root = r.root;
      drop.textContent = st.root ? 'ลากไฟล์ .apk มาวางที่นี่เพื่อติดตั้งแบบเงียบ (root)' : 'ลากไฟล์ .apk มาวางเพื่อติดตั้ง (ยืนยันบนมือถือ)';
      render();
    } catch (e) { list.replaceChildren(el('div', { class: 'notice', text: 'โหลดรายการแอปไม่ได้: ' + e.message })); }
  }
  (async () => { try { st.flavor = (await api('root/status')).flavor; } catch {} load(); })();
  return { handle(arg) { if (arg && arg.install) pick(); } };
}

// ---------------------------------------------------------------- NexOS Wallpaper

const NEX_LOGO = `<g transform="translate(-54,-54)"><rect width="108" height="108" rx="26" fill="#1e6fd9"/><path d="M26,40h22l8,8h32a5,5 0 0 1 5,5v30a5,5 0 0 1 -5,5h-62a5,5 0 0 1 -5,-5v-38a5,5 0 0 1 5,-5z" fill="#ffc94a"/><path d="M54,52l16,16h-11v16h-10v-16h-11z" fill="#fff"/></g>`;

const WALLPAPERS = {
  nexos_dark: {
    name: 'NexOS Dark',
    svg: (w, h, sub) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs><radialGradient id="g" cx="50%" cy="34%" r="80%"><stop offset="0" stop-color="#1b2a44"/><stop offset="55%" stop-color="#0e1626"/><stop offset="1" stop-color="#070b14"/></radialGradient>
      <linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5aa0f0"/><stop offset="1" stop-color="#9f7bff"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      ${rays(w, h, 0.05)}
      <g transform="translate(${w/2},${h*0.4}) scale(${Math.min(w,h)/420})">${NEX_LOGO}</g>
      <text x="${w/2}" y="${h*0.4 + Math.min(w,h)*0.2}" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="700" font-size="${Math.min(w,h)*0.085}" fill="url(#t)">NexOS</text>
      <text x="${w/2}" y="${h*0.4 + Math.min(w,h)*0.26}" text-anchor="middle" font-family="Segoe UI, Arial" font-size="${Math.min(w,h)*0.028}" fill="#8ba0bd" letter-spacing="6">N E X S H A R E</text>
      ${sub ? `<text x="${w/2}" y="${h*0.93}" text-anchor="middle" font-family="Segoe UI, Arial" font-size="${Math.min(w,h)*0.024}" fill="#5b6c84">${esc(sub)}</text>` : ''}
    </svg>`,
  },
  nexos_blue: {
    name: 'NexOS Aqua',
    svg: (w, h, sub) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#d6eefc"/><stop offset="0.4" stop-color="#8fc6ee"/><stop offset="1" stop-color="#3d80c6"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      ${rays(w, h, 0.12)}
      <g transform="translate(${w/2},${h*0.42}) scale(${Math.min(w,h)/380})">${NEX_LOGO}</g>
      <text x="${w/2}" y="${h*0.42 + Math.min(w,h)*0.21}" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="700" font-size="${Math.min(w,h)*0.088}" fill="#13477f">NexOS</text>
      <text x="${w/2}" y="${h*0.42 + Math.min(w,h)*0.275}" text-anchor="middle" font-family="Segoe UI, Arial" font-size="${Math.min(w,h)*0.028}" letter-spacing="6" fill="#1e6fd9">N E X S H A R E</text>
      ${sub ? `<text x="${w/2}" y="${h*0.93}" text-anchor="middle" font-family="Segoe UI, Arial" font-size="${Math.min(w,h)*0.024}" fill="#14467c">${esc(sub)}</text>` : ''}
    </svg>`,
  },
  nexos_grid: {
    name: 'NexOS Grid',
    svg: (w, h, sub) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#101d33"/></linearGradient>
      <pattern id="grid" width="${w/18}" height="${w/18}" patternUnits="userSpaceOnUse"><path d="M${w/18} 0H0V${w/18}" fill="none" stroke="#1d3a5f" stroke-width="1"/></pattern></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/><rect width="${w}" height="${h}" fill="url(#grid)" opacity="0.5"/>
      <circle cx="${w/2}" cy="${h*0.4}" r="${Math.min(w,h)*0.28}" fill="none" stroke="#1e6fd9" stroke-width="2" opacity="0.4"/>
      <g transform="translate(${w/2},${h*0.4}) scale(${Math.min(w,h)/400})">${NEX_LOGO}</g>
      <text x="${w/2}" y="${h*0.4 + Math.min(w,h)*0.2}" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="700" font-size="${Math.min(w,h)*0.082}" fill="#e6edf3">NexOS</text>
      <text x="${w/2}" y="${h*0.4 + Math.min(w,h)*0.255}" text-anchor="middle" font-family="Segoe UI, Arial" font-size="${Math.min(w,h)*0.026}" fill="#5aa0f0" letter-spacing="5">NEXSHARE EDITION</text>
      ${sub ? `<text x="${w/2}" y="${h*0.93}" text-anchor="middle" font-family="monospace" font-size="${Math.min(w,h)*0.022}" fill="#3f6187">${esc(sub)}</text>` : ''}
    </svg>`,
  },
};
function rays(w, h, a) {
  let s = `<g opacity="${a}" fill="#fff">`;
  for (let i = 0; i < 7; i++) { const x = w * (0.6 + i * 0.12); s += `<polygon points="${w},0 ${x},0 ${w},${h * (0.3 + i * 0.1)}"/>`; }
  return s + '</g>';
}
const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function Wallpaper(body, win) {
  const st = { key: 'nexos_dark', showInfo: true, w: screen.width * (devicePixelRatio || 1), h: screen.height * (devicePixelRatio || 1) };
  if (!st.w || st.w < 720) { st.w = 1080; st.h = 2340; }
  const preview = el('div', { style: { flex: '1', display: 'grid', placeItems: 'center', background: '#11161d', minHeight: 0, padding: '14px' } });
  const frame = el('div', { style: { height: '100%', aspectRatio: st.w + '/' + st.h, maxWidth: '100%', borderRadius: '18px', overflow: 'hidden', boxShadow: '0 10px 40px rgba(0,0,0,.5)', border: '6px solid #222' } });
  preview.append(frame);
  const thumbs = el('div', { style: { display: 'flex', gap: '10px', padding: '12px', overflowX: 'auto', borderTop: '1px solid var(--line)' } });
  const infoChk = el('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '13px' } },
    el('input', { type: 'checkbox', checked: true, onchange: e => { st.showInfo = e.target.checked; render(); } }), 'ใส่ชื่อเครื่อง/IP ด้านล่าง');
  const status = el('span', { style: { color: 'var(--text-3)', fontSize: '12px' } });
  const setBtn = el('button', { class: 'btn primary', onclick: e => menuAt(e.currentTarget, [
    { label: 'ตั้งเป็นวอลเปเปอร์ (หน้าหลัก + ล็อก)', run: () => apply('both') },
    { label: 'เฉพาะหน้าหลัก', run: () => apply('home') },
    { label: 'เฉพาะหน้าจอล็อก', run: () => apply('lock') },
    { label: 'ดาวน์โหลดรูป', ico: 'download', run: () => download() },
  ]) }, icon('download'), 'ตั้งเป็นวอลเปเปอร์', icon('chev', 'chev'));
  const bar = el('div', { class: 'ds-tools' }, infoChk, el('span', { style: { flex: 1 } }), status, setBtn);
  body.append(el('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } }, bar, preview, thumbs));

  const sub = () => st.showInfo && Stats.last ? `${Stats.last.name}  ·  ${Stats.last.ip || ''}  ·  nexshare.local` : '';
  const svgOf = key => WALLPAPERS[key].svg(st.w, st.h, sub());

  function render() {
    frame.innerHTML = svgOf(st.key);
    const s = frame.querySelector('svg');
    if (s) { s.setAttribute('width', '100%'); s.setAttribute('height', '100%'); s.style.display = 'block'; }
    thumbs.replaceChildren(...Object.keys(WALLPAPERS).map(k => {
      const t = el('div', { style: { flex: 'none', width: '72px', aspectRatio: st.w + '/' + st.h, borderRadius: '10px', overflow: 'hidden', cursor: 'pointer', border: k === st.key ? '2px solid var(--accent)' : '2px solid transparent' }, onclick: () => { st.key = k; render(); } });
      t.innerHTML = WALLPAPERS[k].svg(st.w, st.h, '');
      const sv = t.querySelector('svg'); if (sv) { sv.setAttribute('width', '100%'); sv.setAttribute('height', '100%'); }
      return t;
    }));
    win.setTitle('Wallpaper — ' + WALLPAPERS[st.key].name);
  }
  async function toBlob() {
    const svg = svgOf(st.key);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const canvas = el('canvas'); canvas.width = st.w; canvas.height = st.h;
    canvas.getContext('2d').drawImage(img, 0, 0, st.w, st.h);
    URL.revokeObjectURL(url);
    return await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  }
  async function apply(which) {
    status.textContent = 'กำลังตั้งวอลเปเปอร์…';
    try {
      const blob = await toBlob();
      const r = await fetch('/api/wallpaper' + qs({ which }), { method: 'POST', body: blob, credentials: 'same-origin' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.status); }
      status.textContent = '';
      toast('ตั้งวอลเปเปอร์ NexOS แล้ว');
    } catch (e) { status.textContent = ''; toast('ไม่สำเร็จ: ' + e.message, 4000); }
  }
  async function download() {
    const blob = await toBlob();
    const a = el('a', { href: URL.createObjectURL(blob), download: 'NexOS-' + st.key + '.jpg' });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  render();
  return {};
}
// ---------------------------------------------------------------- Remote Access (Cloudflare Tunnel)

const TUN_STATE = { off: 'ปิดอยู่', starting: 'กำลังเชื่อมต่อ…', connected: 'เชื่อมต่อแล้ว', error: 'ผิดพลาด' };

function RemoteAccess(body, win) {
  const pane = el('div', { class: 'pane' });
  body.append(pane);
  let timer, lastState = null, logOpen = false;

  async function act(path, payload) {
    try {
      const r = await api('tunnel/' + path, null, payload ? { method: 'POST', body: JSON.stringify(payload) } : { method: 'POST' });
      render(r);
    } catch (e) { toast('ไม่สำเร็จ: ' + e.message, 4000); refresh(); }
  }

  function render(s) {
    lastState = s;
    const connected = s.state === 'connected';
    const dotColor = { off: '#9aa6b2', starting: '#f0a020', connected: '#2fb36b', error: '#e5484d' }[s.state];
    fill(pane,
      el('h2', null, 'เข้าถึงจากอินเทอร์เน็ต (Cloudflare Tunnel)'),
      !s.supported ? el('div', { class: 'notice', text: 'มือถือเครื่องนี้ไม่รองรับ (ไม่มีไฟล์ cloudflared สำหรับ CPU นี้) — ใช้ได้เฉพาะในวง Wi-Fi เดียวกัน' }) : null,
      el('div', { class: 'card' },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: connected || s.state === 'error' ? '12px' : 0 } },
          el('span', { style: { width: '12px', height: '12px', borderRadius: '50%', background: dotColor, flex: 'none' } }),
          el('b', { text: TUN_STATE[s.state] || s.state }),
          s.mode && s.mode !== 'off' ? el('span', { class: 'st-pill', text: s.mode === 'named' ? 'โดเมนตัวเอง' : 'ลิงก์ชั่วคราว' }) : null),
        connected && s.url ? el('div', null,
          el('div', { style: { fontSize: '12px', color: 'var(--text-3)', marginBottom: '4px' }, text: 'ลิงก์สาธารณะ (เปิดได้จากทุกที่):' }),
          el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            el('a', { class: 'mono', href: s.url, target: '_blank', style: { fontSize: '16px', color: 'var(--accent)', wordBreak: 'break-all' }, text: s.url }),
            el('button', { class: 'btn', onclick: () => copy(s.url) }, icon('link'), 'คัดลอก'))) : null,
        connected && s.mode === 'named' && !s.url ? el('div', { class: 'mono', style: { color: 'var(--text-2)' }, text: 'เชื่อมต่อแล้ว — เปิดด้วยโดเมนที่คุณตั้งไว้ใน Cloudflare' }) : null,
        s.state === 'error' ? el('div', { class: 'notice', style: { margin: '0' }, text: s.error || 'เชื่อมต่อไม่สำเร็จ' }) : null),

      s.state === 'off' || s.state === 'error'
        ? el('div', { class: 'card' },
            el('h3', { style: { marginTop: 0 }, text: 'เปิด Tunnel' }),
            el('div', { class: 'notice', style: { margin: '0 0 12px' }, text: 'เมื่อเปิด เครื่องจะเข้าถึงได้จากอินเทอร์เน็ต ระบบจะบังคับเปิด PIN ให้อัตโนมัติ อย่าปิด PIN ขณะเปิด tunnel' }),
            el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' } },
              el('button', { class: 'btn primary', disabled: !s.supported, onclick: () => act('start', { mode: 'quick' }) }, icon('link'), 'ลิงก์ชั่วคราว (trycloudflare.com)')),
            el('h3', { text: 'หรือใช้โดเมนตัวเอง (Named Tunnel)' }),
            el('div', { class: 'hint', style: { marginBottom: '8px' }, html: 'ไปที่ Cloudflare Zero Trust → Networks → Tunnels → สร้าง tunnel → คัดลอก token (ขึ้นต้นด้วย <span class="mono">eyJ…</span>) มาวางด้านล่าง แล้วตั้ง Public hostname ชี้มาที่ <span class="mono">http://localhost:' + (Stats.last ? Stats.last.port : 8080) + '</span>' }),
            (() => {
              const t = el('input', { placeholder: 'วาง tunnel token ที่นี่', value: s.hasToken ? '••••••••••••••••' : '', style: { fontFamily: 'monospace' }, onfocus: e => { if (e.target.value.startsWith('•')) e.target.value = ''; } });
              return el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, t,
                el('button', { class: 'btn', disabled: !s.supported, onclick: () => act('start', { mode: 'named', token: t.value.startsWith('•') ? undefined : t.value }) }, icon('link'), 'เชื่อมต่อด้วย token'));
            })())
        : el('div', { class: 'card' },
            el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              el('button', { class: 'btn danger', onclick: () => act('stop') }, icon('x'), 'ปิด Tunnel'),
              el('button', { class: 'btn', onclick: () => act('start', { mode: s.mode === 'named' ? 'named' : 'quick' }) }, icon('refresh'), 'เชื่อมต่อใหม่'))),

      el('div', { class: 'card' },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }, onclick: () => { logOpen = !logOpen; render(lastState); } },
          el('h3', { style: { margin: 0 }, text: 'บันทึกการทำงาน (log)' }), icon(logOpen ? 'min' : 'chev')),
        logOpen ? el('pre', { class: 'mono', style: { marginTop: '10px', maxHeight: '220px', overflow: 'auto', background: '#0d1117', color: '#c9d1d9', padding: '12px', borderRadius: '8px', fontSize: '12px', whiteSpace: 'pre-wrap', userSelect: 'text' }, text: s.log || '(ยังไม่มี)' }) : null));
  }
  function copy(url) {
    if (navigator.clipboard && isSecureContext) navigator.clipboard.writeText(url).then(() => toast('คัดลอกลิงก์แล้ว'));
    else dialog({ title: 'ลิงก์สาธารณะ', input: url, cancel: false });
  }
  async function refresh() {
    try { render(await api('tunnel/status')); } catch { /* offline */ }
  }
  refresh();
  timer = setInterval(() => { if (!lastState || lastState.state === 'starting' || logOpen) refresh(); }, 2000);
  return { destroy() { clearInterval(timer); } };
}
// ---------------------------------------------------------------- auth & boot

const Auth = {
  pinRequired: null,
  mode: 'pin',
  applyMode() {
    const pw = this.mode === 'password';
    $('#pin').classList.toggle('hidden', pw);
    $('#loginUser').classList.toggle('hidden', !pw);
    $('#loginPass').classList.toggle('hidden', !pw);
    $('#loginServer').textContent = pw ? 'เข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่าน' : 'ใส่ PIN ที่แสดงในแอปบนมือถือ';
  },
  show() {
    this.applyMode();
    $('#login').classList.remove('hidden');
    setTimeout(() => (this.mode === 'password' ? $('#loginUser') : $('#pin')).focus(), 50);
  },
  async logout() {
    try { await api('logout', null, { method: 'POST' }); } catch { /* ignore */ }
    location.reload();
  },
};

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#loginErr');
  err.textContent = '';
  const body = Auth.mode === 'password'
    ? { username: $('#loginUser').value, password: $('#loginPass').value }
    : { pin: $('#pin').value };
  try {
    await api('login', null, { method: 'POST', body: JSON.stringify(body) });
    $('#login').classList.add('hidden');
    $('#pin').value = $('#loginPass').value = '';
    start();
  } catch (x) {
    err.textContent = x.status === 429 ? 'ใส่ผิดหลายครั้ง รอ 1 นาทีแล้วลองใหม่'
      : Auth.mode === 'password' ? 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' : 'PIN ไม่ถูกต้อง';
    (Auth.mode === 'password' ? $('#loginPass') : $('#pin')).select();
  }
});

const APPS = {
  filestation: { id: 'filestation', name: 'File Station', ico: 'filestation', w: 980, h: 600, mount: FileStation },
  photos: { id: 'photos', name: 'Photos', ico: 'photos', w: 900, h: 600, mount: MediaApp('image') },
  videos: { id: 'videos', name: 'Video Station', ico: 'videos', w: 900, h: 600, mount: MediaApp('video') },
  music: { id: 'music', name: 'Audio Station', ico: 'music', w: 640, h: 560, mount: MediaApp('audio') },
  monitor: { id: 'monitor', name: 'Resource Monitor', ico: 'monitor', w: 760, h: 520, mount: ResourceMonitor },
  control: { id: 'control', name: 'Control Panel', ico: 'control', w: 620, h: 600, mount: ControlPanel },
  help: { id: 'help', name: 'NexShare Help', ico: 'help', w: 640, h: 560, mount: Help },
  download: { id: 'download', name: 'Download Station', ico: 'download', w: 960, h: 560, mount: DownloadStation },
  player: { id: 'player', name: 'Media Player', ico: 'player', w: 1000, h: 600, mount: MediaPlayer },
  packagecenter: { id: 'packagecenter', name: 'Package Center', ico: 'packagecenter', w: 760, h: 580, mount: PackageCenter },
  terminal: { id: 'terminal', name: 'Terminal', ico: 'terminal', w: 820, h: 540, mount: Terminal, root: true },
  screen: { id: 'screen', name: 'Screen Mirror', ico: 'screen', w: 520, h: 640, mount: ScreenMirror, root: true },
  wallpaper: { id: 'wallpaper', name: 'Wallpaper', ico: 'photos', w: 520, h: 640, mount: Wallpaper },
  remote: { id: 'remote', name: 'Remote Access', ico: 'remote', w: 660, h: 620, mount: RemoteAccess },
};

$('#mainMenuBtn').onclick = e => openPop && openPop.btn === e.currentTarget ? closePop() : appGridPopover(e.currentTarget, Object.keys(APPS).filter(k => !APPS[k].root || State.isRoot), 'ค้นหาแอป');
$('#searchBtn').onclick = () => openApp('filestation', { search: true });
$('#infoBtn').onclick = () => openApp('control');
$('#userBtn').onclick = e => menuAt(e.currentTarget, [
  { label: Stats.last ? Stats.last.model : 'NexShare', ico: 'info', run: () => openApp('control') },
  Auth.pinRequired ? { label: 'ออกจากระบบ', ico: 'logout', run: () => Auth.logout() } : null,
]);
$('#notifBtn').onclick = e => {
  const items = State.notes.length ? State.notes.slice(0, 8).map(n => ({ label: n.text, run: () => {} })) : [{ label: 'ยังไม่มีการแจ้งเตือน', disabled: true, run: () => {} }];
  menuAt(e.currentTarget, items);
};
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { if (!e.target.closest('.fs-list')) { e.preventDefault(); toast('เปิด File Station แล้ววางไฟล์ในหน้าต่างเพื่ออัปโหลด'); } });
addEventListener('resize', () => { renderDesktop(); });

let started = false;
async function start() {
  try {
    const r = await api('roots');
    State.roots = r.roots;
  } catch (e) { if (e.status === 401) return; }
  renderDesktop();
  Taskbar.render();
  if (started) return;
  started = true;
  initWidgets();
  poll();
  setInterval(poll, 2000);
  if (State.roots.length && !State.roots[0].readable) notify('แอปบนมือถือยังไม่ได้รับสิทธิ์เข้าถึงไฟล์');
  if (innerWidth > 760) openApp('filestation');
}

(async function boot() {
  for (const n of document.querySelectorAll('[data-ico]')) n.innerHTML = APP_ICO[n.dataset.ico];
  renderDesktop();
  Taskbar.render();
  try {
    const s = await api('session');
    Auth.pinRequired = s.pinRequired;
    Auth.mode = s.authMode || 'pin';
    State.authMode = Auth.mode;
    State.flavor = s.flavor || 'normal';
    State.isRoot = !!s.root;
    if (!s.auth) { Auth.show(); return; }
    start();
  } catch { toast('เชื่อมต่อมือถือไม่ได้'); }
})();
