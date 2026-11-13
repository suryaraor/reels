// Reels: an Instagram-style reel player for every folder under data/. Backend: Google Sheet via Apps Script (see Code.gs).
// Paste your deployed Apps Script URL here so everyone you share a link with can like and comment,
// or enter it on the "Connect Google Sheet" screen (saved in that browser only).
const DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbxQR__lxx2fA0BYMWyHjVbeN0nkTis6u_Gm7WIMWrQfoszNflT1V7MLpOiBY6l_am6lbw/exec';

const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: fine */ } }
};
const CONFIG = { appsScriptUrl: store.get('reels_appsScriptUrl') || DEFAULT_URL };
// Anonymous per-browser id, so a like can be undone and your own comments deleted (no sign-in)
const USER = store.get('reels_user') || (() => {
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    store.set('reels_user', id);
    return id;
})();

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const state = {
    manifest: null, folder: null, list: [], tag: null, index: -1, reels: [], stats: {},
    muted: true, userPaused: false, sheetKind: null, sheetVideo: null, failures: 0
};

// ---------- Icons (Lucide paths) ----------
const ICONS = {
    film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    comment: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    volOn: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    volOff: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6M16 9l6 6"/>',
    play: '<path d="M6 3l14 9-14 9Z"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    whatsapp: '<path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 20.5l1.7-5.4A8.4 8.4 0 1 1 21 11.5Z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.2-2-1-.8.7c-.8-.4-1.5-1.1-1.9-1.9l.7-.8-1-2Z"/>'
};
function icon(name, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name];
    return s;
}
function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}
const show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
function setIcon(node, name, label) { node.replaceChildren(icon(name), ...(label ? [document.createTextNode(label)] : [])); }

let toastTimer;
function toast(msg) {
    $('toast').textContent = msg;
    show('toast', true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => show('toast', false), 3500);
}
function showError(msg) { $('errorMessage').textContent = msg; show('errorMessage', !!msg); }

// ---------- API (JSONP, so a static page works from GitHub Pages without CORS) ----------
let jsonpCounter = 0;
function api(params) {
    return new Promise((resolve, reject) => {
        if (!CONFIG.appsScriptUrl) return reject(new Error('Not connected to Google Sheet'));
        const cb = `rlCb_${Date.now()}_${jsonpCounter++}`;
        const script = document.createElement('script');
        const done = () => { clearTimeout(timer); delete window[cb]; script.remove(); };
        const timer = setTimeout(() => { done(); reject(new Error('Request timed out')); }, 25000);
        window[cb] = (d) => { done(); d.success ? resolve(d) : reject(new Error(d.error || 'Request failed')); };
        script.onerror = () => { done(); reject(new Error('Unable to reach Apps Script endpoint')); };
        script.src = `${CONFIG.appsScriptUrl}?${new URLSearchParams({ ...params, callback: cb })}`;
        document.body.appendChild(script);
    });
}

// ---------- Videos (titles, descriptions and hashtags come from the file names; see build.js) ----------
const tagOf = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');

async function loadManifest() {
    if (state.manifest) return state.manifest;
    const r = await fetch('videos.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('videos.json not found. Run "node build.js" in the project folder first.');
    const m = await r.json();
    m.folders.forEach((f) => {
        f.tagCounts = {};
        f.videos.forEach((v) => v.tags.forEach((t) => { f.tagCounts[t] = (f.tagCounts[t] || 0) + 1; }));
    });
    state.manifest = m;
    return m;
}
function findFolder(name) {
    const fs = state.manifest.folders;
    const low = (name || '').toLowerCase();
    return fs.find((f) => f.name === name) || fs.find((f) => f.name.toLowerCase() === low) || null;
}

// ---------- Links ----------
// Shared links point at the small pages in r/ that build.js makes: they carry the preview (picture, title,
// hashtags) for WhatsApp, iMessage, Slack, X... and send people straight into the reel.
const base = () => location.origin + location.pathname.replace(/index\.html$/, '');
const folderLink = (f) => base() + (f.share || `#/${enc(f.name)}`);
const videoLink = (f, v) => base() + (v.share || `#/${enc(f.name)}/${enc(v.stem)}`);
function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, query] = h.split('?');
    let parts = [];
    try { parts = path.split('/').filter(Boolean).map(decodeURIComponent); } catch (e) { /* bad link */ }
    return { folder: parts[0] || null, video: parts[1] || null, tag: new URLSearchParams(query || '').get('tag') };
}

// ---------- Router ----------
document.addEventListener('DOMContentLoaded', init);
window.addEventListener('hashchange', route);

function init() {
    const h = $('hdrTitle');
    h.append(icon('film'), el('span', '', 'Reels'));
    setIcon($('reelBack'), 'back');
    setIcon($('filterBtn'), 'hash');
    setIcon($('prevBtn'), 'up');
    setIcon($('nextBtn'), 'down');
    setIcon($('shCopy'), 'link', 'Copy link');
    setIcon($('shWhatsapp'), 'whatsapp', 'WhatsApp');
    setIcon($('shNative'), 'share', 'More…');
    syncMute();

    $('reelBack').addEventListener('click', () => { location.hash = '#/'; });
    $('filterBtn').addEventListener('click', openTagSheet);
    $('tagClear').addEventListener('click', () => setTag(null));
    $('tagAll').addEventListener('click', () => { closeSheet(); setTag(null); });
    $('muteBtn').addEventListener('click', toggleMute);
    $('prevBtn').addEventListener('click', () => go(state.index - 1));
    $('nextBtn').addEventListener('click', next);
    $('feed').addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => { if (state.index >= 0) $('feed').scrollTop = state.index * $('feed').clientHeight; });

    document.querySelectorAll('.sheet-close').forEach((b) => { b.appendChild(icon('x')); b.addEventListener('click', closeSheet); });
    $('sheetBackdrop').addEventListener('click', closeSheet);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', () => {
        const v = current() && current().video;
        if (!v || !document.body.classList.contains('reel-mode')) return;
        if (document.visibilityState === 'hidden') v.pause();
        else if (!state.userPaused) playCurrent();
    });

    $('saveUrlBtn').addEventListener('click', () => {
        const url = $('urlInput').value.trim();
        if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return toast('That does not look like an Apps Script web app URL.');
        store.set('reels_appsScriptUrl', url);
        CONFIG.appsScriptUrl = url;
        toast('Connected. Likes and comments will be saved.');
        route();
    });
    $('cancelUrlBtn').addEventListener('click', route);
    initCommentSheet();
    initShareSheet();
    route();
}

async function route() {
    showError('');
    show('setupView', false);
    let m;
    try {
        m = await loadManifest();
    } catch (err) {
        leaveReels();
        show('loadingIndicator', false);
        return showError(err.message);
    }
    const h = parseHash();
    const f = h.folder ? findFolder(h.folder) : null;
    if (h.folder && !f) {
        leaveReels();
        renderHome(m);
        return showError(`No collection called "${h.folder}".`);
    }
    if (f) openFolder(f, h.video, h.tag);
    else { leaveReels(); renderHome(m); }
}

// ---------- Home ----------
function renderHome(m) {
    document.title = 'Reels';
    show('loadingIndicator', false);
    show('homeView', true);
    const list = $('folderList');
    list.replaceChildren();
    if (!m.folders.length) list.appendChild(el('div', 'empty', 'No videos yet. Add a folder of videos under data/ and run "node build.js".'));
    m.folders.forEach((f) => {
        const card = el('div', 'folder-card');
        const open = el('button', 'folder-open');
        open.type = 'button';
        const thumbs = el('div', 'thumbs');
        f.videos.slice(0, 2).forEach((v) => {
            const s = el('span');
            if (v.poster) s.style.backgroundImage = `url("${v.poster}")`;
            thumbs.appendChild(s);
        });
        thumbs.appendChild(icon('play'));
        const meta = el('div', 'folder-meta');
        const top = Object.entries(f.tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([t]) => '#' + t);
        meta.append(el('div', 'name', f.name), el('div', 'sub', `${f.videos.length} reel${f.videos.length === 1 ? '' : 's'}`), el('div', 'tags', top.join(' ')));
        open.append(thumbs, meta);
        open.addEventListener('click', () => { location.hash = `#/${enc(f.name)}`; });
        const share = el('button', 'icon-btn');
        share.type = 'button';
        share.setAttribute('aria-label', `Share link to ${f.name}`);
        share.appendChild(icon('link'));
        share.addEventListener('click', () => shareOrCopy(folderLink(f), `${f.name} · Reels`));
        card.append(open, share);
        list.appendChild(card);
    });
    const conn = $('connBox');
    conn.replaceChildren();
    const dot = el('span', 'dot' + (CONFIG.appsScriptUrl ? ' on' : ''));
    const btn = el('button', '', CONFIG.appsScriptUrl ? 'Change' : 'Connect');
    btn.type = 'button';
    btn.addEventListener('click', openSetup);
    conn.append(dot, CONFIG.appsScriptUrl ? 'Saving likes & comments to Google Sheet.' : 'Not connected to Google Sheet, so likes and comments are off.', btn);
}
function openSetup() {
    leaveReels();
    show('homeView', false);
    show('loadingIndicator', false);
    $('urlInput').value = CONFIG.appsScriptUrl;
    show('setupView', true);
    $('urlInput').focus();
}

// ---------- Reels player ----------
function openFolder(f, videoStem, tag) {
    const same = state.folder === f && document.body.classList.contains('reel-mode');
    state.folder = f;
    state.tag = tag && f.tagCounts[tagOf(tag)] ? tagOf(tag) : null;
    document.body.classList.add('reel-mode');
    show('homeView', false);
    show('loadingIndicator', false);
    show('reelView', true);
    $('reelTitle').textContent = f.name;
    document.title = `${f.name} · Reels`;
    buildFeed(videoStem);
    if (!same) { state.stats = {}; loadStats(); }
}

function leaveReels() {
    if (!document.body.classList.contains('reel-mode')) return;
    closeSheet();
    state.reels.forEach((r) => unload(r.video));
    state.reels = [];
    state.index = -1;
    $('feed').replaceChildren();
    show('reelView', false);
    document.body.classList.remove('reel-mode');
    state.folder = null;
}

function buildFeed(startStem) {
    const f = state.folder;
    state.reels.forEach((r) => unload(r.video));
    state.list = state.tag ? f.videos.filter((v) => v.tags.includes(state.tag)) : f.videos.slice();
    state.reels = state.list.map(makeReel);
    state.index = -1;
    state.failures = 0;
    const feed = $('feed');
    feed.replaceChildren(...state.reels.map((r) => r.el));
    const start = Math.max(0, state.list.findIndex((v) => v.stem === startStem));
    $('reelSub').textContent = state.tag ? `${state.list.length} of ${f.videos.length} reels with #${state.tag}` : `${f.videos.length} reels`;
    const pill = $('tagClear');
    pill.replaceChildren(el('span', '', '#' + state.tag), icon('x'));
    show('tagClear', !!state.tag);
    $('filterBtn').classList.toggle('on', !!state.tag);
    feed.scrollTop = start * feed.clientHeight;
    activate(start);
}

function makeReel(v, i) {
    const r = { v, el: el('div', 'reel') };
    const stage = el('div', 'stage');
    const video = el('video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'none';
    video.dataset.src = v.src;
    if (v.poster) video.poster = v.poster;
    video.addEventListener('ended', () => { if (current() === r) onEnded(); });
    video.addEventListener('timeupdate', () => { if (video.duration) bar.style.width = `${(video.currentTime / video.duration) * 100}%`; });
    video.addEventListener('playing', () => { r.el.classList.remove('paused'); state.failures = 0; });
    video.addEventListener('error', () => { if (current() === r && video.getAttribute('src')) onVideoError(); });
    r.video = video;

    const flash = el('div', 'flash');
    flash.appendChild(icon('play'));
    const progress = el('div', 'progress');
    const bar = el('i');
    progress.appendChild(bar);
    const counter = el('div', 'counter', `${i + 1} / ${state.list.length}`);

    const caption = el('div', 'caption');
    const tags = el('div', 'cap-tags');
    v.tags.forEach((t) => {
        const b = el('button', t === state.tag ? 'on' : '', '#' + t);
        b.type = 'button';
        b.addEventListener('click', (e) => { e.stopPropagation(); setTag(t === state.tag ? null : t); });
        tags.appendChild(b);
    });
    caption.append(el('div', 'cap-folder', state.folder.name), el('h2', 'cap-title', v.title), el('p', 'cap-desc', v.description), tags);
    stage.append(video, flash, counter, caption, progress);

    // Tap: play/pause. Double tap: like with a heart burst.
    let lastTap = 0, tapTimer;
    stage.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const now = Date.now();
        if (now - lastTap < 300) {
            clearTimeout(tapTimer);
            lastTap = 0;
            heartBurst(stage, e);
            if (!stat(v).liked) setLike(r, true);
            return;
        }
        lastTap = now;
        tapTimer = setTimeout(() => togglePlay(r), 300);
    });

    const actions = el('div', 'actions');
    const mk = (cls, name, label, fn) => {
        const b = el('button', 'act ' + cls);
        b.type = 'button';
        b.setAttribute('aria-label', label);
        const bub = el('span', 'bub');
        bub.appendChild(icon(name));
        b.append(bub, el('small', '', ''));
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        actions.appendChild(b);
        return b;
    };
    r.likeBtn = mk('like', 'heart', 'Like', () => setLike(r, !stat(v).liked));
    r.commentBtn = mk('cmt', 'comment', 'Comments', () => openComments(r));
    r.shareBtn = mk('shr', 'send', 'Share', () => openShare(r));
    r.el.append(stage, actions);
    r.flash = flash;
    renderStat(r);
    return r;
}

const current = () => state.reels[state.index];

function onScroll() {
    if (onScroll.raf) return;
    onScroll.raf = requestAnimationFrame(() => {
        onScroll.raf = 0;
        const feed = $('feed');
        const i = Math.round(feed.scrollTop / Math.max(1, feed.clientHeight));
        if (i !== state.index && i >= 0 && i < state.reels.length) activate(i);
    });
}

// Make reel i the playing one; keep only it and its neighbours loaded
function activate(i) {
    const n = state.reels.length;
    if (!n) return;
    state.index = i;
    state.userPaused = false;
    state.reels.forEach((r, j) => {
        const d = Math.min(Math.abs(j - i), n - Math.abs(j - i)); // neighbours wrap around (last -> first)
        if (d <= 1) load(r.video);
        else if (d > 2) unload(r.video);
        if (j !== i && !r.video.paused) r.video.pause();
    });
    const v = current().video;
    if (v.readyState > 0) v.currentTime = 0;
    playCurrent();
}
function load(v) { if (!v.getAttribute('src')) { v.preload = 'auto'; v.src = v.dataset.src; } }
function unload(v) {
    if (!v.getAttribute('src')) return;
    v.pause();
    v.removeAttribute('src');
    v.load();
}

function playCurrent() {
    const r = current();
    if (!r) return;
    const v = r.video;
    load(v);
    v.muted = state.muted;
    const p = v.play();
    if (p && p.catch) p.catch((err) => {
        if (err.name === 'AbortError') return; // interrupted by the next swipe
        if (!v.muted) {
            // Browser blocked sound without a tap: fall back to muted autoplay
            state.muted = true;
            syncMute();
            v.muted = true;
            v.play().catch(() => r.el.classList.add('paused'));
        } else r.el.classList.add('paused');
    });
}

function togglePlay(r) {
    const v = r.video;
    if (v.paused) {
        state.userPaused = false;
        playCurrent();
    } else {
        v.pause();
        state.userPaused = true;
        r.el.classList.add('paused');
    }
}

// Video finished: go to the next one, wrapping to the first after the last.
// While comments/share are open the same reel repeats instead, so the sheet stays on the right video.
function onEnded() {
    if (state.sheetKind === 'comments' || state.sheetKind === 'share' || state.reels.length === 1) {
        const v = current().video;
        v.currentTime = 0;
        return playCurrent();
    }
    next();
}
function next() {
    if (state.index + 1 >= state.reels.length) {
        toast('That was the last one. Playing from the start.');
        return go(0, true);
    }
    go(state.index + 1);
}
function go(i, instant) {
    if (i < 0 || i >= state.reels.length) return;
    const feed = $('feed');
    feed.scrollTo({ top: i * feed.clientHeight, behavior: instant ? 'auto' : 'smooth' });
    if (instant || i === state.index) activate(i);
}
function onVideoError() {
    state.failures++;
    toast('This video could not be played. Skipping.');
    if (state.failures < state.reels.length) setTimeout(next, 1200);
}

function toggleMute() {
    state.muted = !state.muted;
    syncMute();
    const r = current();
    if (r) { r.video.muted = state.muted; if (r.video.paused && !state.userPaused) playCurrent(); }
}
function syncMute() {
    setIcon($('muteBtn'), state.muted ? 'volOff' : 'volOn');
    $('muteBtn').setAttribute('aria-label', state.muted ? 'Turn sound on' : 'Turn sound off');
    $('muteBtn').classList.toggle('on', state.muted);
}

function heartBurst(stage, e) {
    const rect = stage.getBoundingClientRect();
    const h = el('div', 'burst');
    h.appendChild(icon('heart'));
    h.style.left = `${e.clientX - rect.left}px`;
    h.style.top = `${e.clientY - rect.top}px`;
    stage.appendChild(h);
    setTimeout(() => h.remove(), 850);
}

function onKey(e) {
    if (e.key === 'Escape') return closeSheet();
    if (!document.body.classList.contains('reel-mode') || state.sheetKind || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const r = current();
    if (!r) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(state.index - 1); }
    else if (e.key === ' ') { e.preventDefault(); togglePlay(r); }
    else if (e.key === 'm') toggleMute();
    else if (e.key === 'l') setLike(r, !stat(r.v).liked);
}

// ---------- Hashtag filter ----------
function setTag(tag) {
    const f = state.folder;
    const keep = current() && current().v.stem;
    state.tag = tag;
    history.replaceState(null, '', `#/${enc(f.name)}${tag ? `?tag=${enc(tag)}` : ''}`);
    buildFeed(keep);
    if (tag) toast(`Showing ${state.list.length} reel${state.list.length === 1 ? '' : 's'} with #${tag}`);
}
function openTagSheet() {
    const cloud = $('tagCloud');
    cloud.replaceChildren();
    Object.entries(state.folder.tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([t, n]) => {
        const b = el('button', 'tag-chip' + (t === state.tag ? ' on' : ''), '#' + t);
        b.type = 'button';
        b.appendChild(el('small', '', String(n)));
        b.addEventListener('click', () => { closeSheet(); setTag(t === state.tag ? null : t); });
        cloud.appendChild(b);
    });
    openSheet('tagSheet', 'tags');
}

// ---------- Likes / counts ----------
const ZERO = { likes: 0, comments: 0, shares: 0, liked: false };
const stat = (v) => state.stats[v.stem] || ZERO;
const fmtCount = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n));

function renderStat(r) {
    const s = stat(r.v);
    r.likeBtn.classList.toggle('liked', s.liked);
    r.likeBtn.setAttribute('aria-pressed', String(s.liked));
    r.likeBtn.lastChild.textContent = s.likes ? fmtCount(s.likes) : 'Like';
    r.commentBtn.lastChild.textContent = s.comments ? fmtCount(s.comments) : 'Comment';
    r.shareBtn.lastChild.textContent = s.shares ? fmtCount(s.shares) : 'Share';
}
function putStat(stem, s) {
    state.stats[stem] = s;
    state.reels.filter((r) => r.v.stem === stem).forEach(renderStat);
}

async function loadStats() {
    if (!CONFIG.appsScriptUrl) return;
    const folder = state.folder;
    try {
        const d = await api({ action: 'getFolder', folder: folder.name, user: USER });
        if (state.folder !== folder) return;
        state.stats = d.stats || {};
        state.reels.forEach(renderStat);
    } catch (err) { toast(`Could not load likes: ${err.message}`); }
}

let likeSeq = 0;
async function setLike(r, liked) {
    if (!CONFIG.appsScriptUrl) return toast('Likes are off until the Google Sheet is connected.');
    const v = r.v, before = stat(v);
    putStat(v.stem, { ...before, liked, likes: Math.max(0, before.likes + (liked ? 1 : -1)) });
    const seq = ++likeSeq;
    try {
        const d = await api({ action: 'setLike', folder: state.folder.name, video: v.stem, user: USER, liked: liked ? '1' : '0' });
        if (seq === likeSeq) putStat(v.stem, d.stat);
    } catch (err) {
        putStat(v.stem, before);
        toast(err.message);
    }
}

// ---------- Bottom sheets ----------
function openSheet(id, kind) {
    closeSheet();
    state.sheetKind = kind;
    show('sheetBackdrop', true);
    show(id, true);
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => $(id).classList.add('up'));
}
function closeSheet() {
    if (!state.sheetKind) return;
    state.sheetKind = null;
    state.sheetVideo = null;
    ['commentSheet', 'shareSheet', 'tagSheet'].forEach((id) => { $(id).classList.remove('up'); show(id, false); });
    show('sheetBackdrop', false);
    document.body.classList.remove('sheet-open');
}

// ---------- Comments ----------
const PALETTE = ['#cf4520', '#3b8454', '#2f6fa3', '#8a4fa0', '#c08a1e', '#b0396b', '#2a8a8a', '#6b5b45'];
function colorFor(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 604800) return `${Math.floor(s / 86400)}d`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function initCommentSheet() {
    $('cmPost').addEventListener('click', postComment);
    $('cmText').addEventListener('keydown', (e) => { if (e.key === 'Enter') postComment(); });
}
function syncName() {
    const name = store.get('reels_name');
    show('cmNameBox', !name);
    show('cmAs', !!name);
    if (name) {
        const change = el('button', '', 'change');
        change.type = 'button';
        change.addEventListener('click', () => { $('cmName').value = name; show('cmNameBox', true); show('cmAs', false); $('cmName').focus(); });
        $('cmAs').replaceChildren(`Commenting as ${name} · `, change);
    }
}
async function openComments(r) {
    $('cmVideo').textContent = r.v.title;
    $('cmText').value = '';
    syncName();
    openSheet('commentSheet', 'comments');
    state.sheetVideo = r;
    const list = $('commentList');
    if (!CONFIG.appsScriptUrl) {
        list.replaceChildren(el('div', 'cm-empty', 'Comments are off until the Google Sheet is connected.'));
        return;
    }
    list.replaceChildren(el('div', 'cm-empty', 'Loading comments…'));
    try {
        const d = await api({ action: 'getComments', folder: state.folder.name, video: r.v.stem, user: USER });
        if (state.sheetVideo === r) renderComments(d.comments);
    } catch (err) { if (state.sheetVideo === r) list.replaceChildren(el('div', 'cm-empty', `Could not load comments: ${err.message}`)); }
}
function renderComments(comments) {
    const list = $('commentList');
    list.replaceChildren();
    if (!comments.length) return list.appendChild(el('div', 'cm-empty', 'No comments yet. Be the first.'));
    comments.forEach((c) => {
        const row = el('div', 'cm');
        const av = el('div', 'av', (c.name.trim()[0] || '?').toUpperCase());
        av.style.background = colorFor(c.name);
        const body = el('div', 'body');
        const who = el('div', 'who', c.name);
        who.appendChild(el('small', '', timeAgo(c.created)));
        body.append(who, el('div', 'txt', c.text));
        row.append(av, body);
        if (c.mine) {
            const del = el('button', 'del');
            del.type = 'button';
            del.setAttribute('aria-label', 'Delete comment');
            del.appendChild(icon('trash'));
            del.addEventListener('click', () => deleteComment(c, del));
            row.appendChild(del);
        }
        list.appendChild(row);
    });
    list.lastChild.scrollIntoView({ block: 'nearest' });
}
async function postComment() {
    const r = state.sheetVideo;
    if (!r) return;
    if (!CONFIG.appsScriptUrl) return toast('Comments are off until the Google Sheet is connected.');
    const text = $('cmText').value.trim();
    if (!text) return $('cmText').focus();
    let name = store.get('reels_name');
    if ($('cmNameBox').style.display !== 'none') {
        name = $('cmName').value.trim();
        if (!name) { toast('Please add your name.'); return $('cmName').focus(); }
        store.set('reels_name', name);
    }
    const btn = $('cmPost');
    btn.disabled = true;
    try {
        const d = await api({ action: 'addComment', folder: state.folder.name, video: r.v.stem, user: USER, name, text });
        $('cmText').value = '';
        syncName();
        putStat(r.v.stem, d.stat);
        if (state.sheetVideo === r) renderComments(d.comments);
    } catch (err) { toast(err.message); }
    btn.disabled = false;
}
async function deleteComment(c, btn) {
    const r = state.sheetVideo;
    btn.disabled = true;
    try {
        const d = await api({ action: 'deleteComment', id: c.id, user: USER });
        putStat(r.v.stem, d.stat);
        if (state.sheetVideo === r) renderComments(d.comments);
        toast('Comment deleted.');
    } catch (err) { toast(err.message); btn.disabled = false; }
}

// ---------- Share ----------
function initShareSheet() {
    show('shNative', !!navigator.share);
    $('shCopy').addEventListener('click', async () => {
        const r = state.sheetVideo;
        if (await copyText($('shLink').value)) { toast('Link copied.'); recordShare(r, 'link'); closeSheet(); }
        else { $('shLink').select(); toast('Press Ctrl+C to copy the link.'); }
    });
    $('shWhatsapp').addEventListener('click', () => {
        const r = state.sheetVideo;
        window.open(`https://wa.me/?text=${enc(`${r.v.title}\n${$('shLink').value}`)}`, '_blank', 'noopener');
        recordShare(r, 'whatsapp');
        closeSheet();
    });
    $('shNative').addEventListener('click', async () => {
        const r = state.sheetVideo;
        try {
            await navigator.share({ title: r.v.title, text: r.v.title, url: $('shLink').value });
            recordShare(r, 'native');
            closeSheet();
        } catch (e) { /* cancelled */ }
    });
}
function openShare(r) {
    $('shVideo').textContent = r.v.title;
    $('shLink').value = videoLink(state.folder, r.v);
    openSheet('shareSheet', 'share');
    state.sheetVideo = r;
}
async function recordShare(r, channel) {
    if (!r || !CONFIG.appsScriptUrl) return;
    const before = stat(r.v);
    putStat(r.v.stem, { ...before, shares: before.shares + 1 });
    try {
        const d = await api({ action: 'addShare', folder: state.folder.name, video: r.v.stem, user: USER, channel });
        putStat(r.v.stem, d.stat);
    } catch (err) { /* the count is a nicety; the link was still shared */ }
}
async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
    const t = el('textarea');
    t.value = text;
    t.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    t.remove();
    return ok;
}
async function shareOrCopy(url, title) {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    toast(await copyText(url) ? 'Link copied.' : url);
}
