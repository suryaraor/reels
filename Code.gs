// Reels backend: Google Apps Script web app that uses a Google Sheet as the database for likes, comments, shares
// and watch stats. Paste this whole file into the Apps Script editor (Extensions > Apps Script) of the sheet, then
// Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone). See README.md.
//
// Tabs are created automatically the first time the app needs them:
//   Likes    : id, folder, video, user, created
//   Comments : id, folder, video, user, name, text, created
//   Shares   : id, folder, video, user, channel, created
//   Views    : one row per view: seconds watched, how far it got (percent) and how it ended (outcome):
//              full = played to the end, skip = moved to another reel part-way, exit = left the page part-way
//   Videos   : running totals per video (views, full views, skips, exits, watch time, average % watched...)
//   Users    : running totals per viewer (visits, views, watch time, likes, comments, shares, device, browser...)
// "folder" is the folder name under data/, "video" is the file name without its extension,
// "user" is a random id the browser makes for itself (no sign-in), "session" is one per browser tab visit.

const SHEET_ID = '1mVeDm8GZsmS3axKWfXsE3M4DqieVCNi-WRw-8Rej1eI'; // the Reels Google Sheet
const TABS = {
    Likes: ['id', 'folder', 'video', 'user', 'created'],
    Comments: ['id', 'folder', 'video', 'user', 'name', 'text', 'created'],
    Shares: ['id', 'folder', 'video', 'user', 'channel', 'created'],
    Views: ['id', 'folder', 'video', 'user', 'session', 'watched', 'duration', 'percent', 'outcome', 'created'],
    Videos: ['folder', 'video', 'views', 'fullViews', 'skips', 'exits', 'watchSeconds', 'avgWatchSeconds', 'avgPercent', 'completionRate', 'updated'],
    Users: ['user', 'firstSeen', 'lastSeen', 'visits', 'views', 'fullViews', 'skips', 'exits', 'watchSeconds',
        'likes', 'comments', 'shares', 'device', 'os', 'browser', 'language', 'timezone', 'referrer', 'lastSession']
};
// Columns kept as numbers (everything else is stored as plain text)
const NUMBERS = ['watched', 'duration', 'percent', 'views', 'fullViews', 'skips', 'exits', 'watchSeconds', 'avgWatchSeconds',
    'avgPercent', 'completionRate', 'visits', 'likes', 'comments', 'shares'];
const OUTCOMES = { full: 'fullViews', skip: 'skips', exit: 'exits' };
// Timestamps are saved in US Central time, e.g. "2026-11-13 11:21:04 CST" ("CDT" during daylight saving time)
const TZ = 'America/Chicago';
const TIME_COLS = ['created', 'updated', 'firstSeen', 'lastSeen'];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function doGet(e) {
    const p = e.parameter || {};
    let out;
    try {
        const lock = LockService.getScriptLock();
        lock.waitLock(20000);
        try { migrateTimestamps(); out = handle(p); } finally { lock.releaseLock(); }
    } catch (err) {
        out = { success: false, error: String(err && err.message || err) };
    }
    const json = JSON.stringify(out);
    const cb = /^[\w.$]+$/.test(p.callback || '') ? p.callback : null;
    return ContentService
        .createTextOutput(cb ? cb + '(' + json + ')' : json)
        .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

function handle(p) {
    switch (p.action) {
        case 'getFolder': return { success: true, stats: folderStats(need(p, 'folder'), p.user || '') };
        case 'setLike': {
            const folder = need(p, 'folder'), video = need(p, 'video'), user = need(p, 'user');
            const mine = rows('Likes').filter(r => r.folder === folder && r.video === video && r.user === user);
            if (p.liked === '1' && !mine.length) {
                insert('Likes', { id: newId(), folder, video, user, created: now() });
                bumpUser(user, { likes: 1 });
            }
            if (p.liked !== '1' && mine.length) {
                mine.reverse().forEach(r => sheet('Likes').deleteRow(r._row));
                bumpUser(user, { likes: -mine.length });
            }
            return { success: true, stat: videoStat(folder, video, user) };
        }
        case 'getComments': return { success: true, comments: commentList(need(p, 'folder'), need(p, 'video'), p.user || '') };
        case 'addComment': {
            const folder = need(p, 'folder'), video = need(p, 'video'), user = need(p, 'user');
            const text = need(p, 'text').slice(0, 500);
            const name = String(p.name || '').trim().slice(0, 40) || 'Guest';
            insert('Comments', { id: newId(), folder, video, user, name, text, created: now() });
            bumpUser(user, { comments: 1 });
            return { success: true, comments: commentList(folder, video, user), stat: videoStat(folder, video, user) };
        }
        case 'deleteComment': {
            const user = need(p, 'user');
            const c = rows('Comments').filter(r => r.id === need(p, 'id'))[0];
            if (!c) throw new Error('Comment not found');
            if (c.user !== user) throw new Error('You can only delete your own comments');
            sheet('Comments').deleteRow(c._row);
            bumpUser(user, { comments: -1 });
            return { success: true, comments: commentList(c.folder, c.video, user), stat: videoStat(c.folder, c.video, user) };
        }
        case 'addShare': {
            const folder = need(p, 'folder'), video = need(p, 'video'), user = p.user || '';
            insert('Shares', { id: newId(), folder, video, user, channel: String(p.channel || 'link').slice(0, 20), created: now() });
            if (user) bumpUser(user, { shares: 1 });
            return { success: true, stat: videoStat(folder, video, user) };
        }
        case 'track': return { success: true, saved: track(p) };
        default: throw new Error('Unknown action');
    }
}

// ---------- Watch stats ----------
// p.events is a JSON list of views: [{ f: folder, v: video, w: seconds watched, d: duration, p: percent reached, o: outcome }]
function track(p) {
    const user = need(p, 'user'), session = String(p.session || '').slice(0, 24);
    let events;
    try { events = JSON.parse(p.events || '[]'); } catch (e) { throw new Error('Bad events'); }
    if (!Array.isArray(events)) throw new Error('Bad events');
    const views = events.slice(0, 25).map(cleanEvent).filter(Boolean);
    if (!views.length) return 0;
    const t = now(), cols = TABS.Views, sh = sheet('Views');
    sh.getRange(sh.getLastRow() + 1, 1, views.length, cols.length)
        .setValues(views.map(v => cols.map(c => cell(c, Object.assign({ id: newId(), user, session, created: t }, v)[c]))));

    // Running totals per video
    const all = rows('Videos'), byKey = {};
    all.forEach(r => { byKey[r.folder + '\n' + r.video] = r; });
    const changed = [];
    views.forEach(v => {
        const k = v.folder + '\n' + v.video;
        let r = byKey[k];
        if (!r) r = byKey[k] = { folder: v.folder, video: v.video };
        if (changed.indexOf(r) < 0) changed.push(r);
        const n = num(r.views) + 1;
        r.avgPercent = round1((num(r.avgPercent) * num(r.views) + v.percent) / n);
        r.views = n;
        r[OUTCOMES[v.outcome]] = num(r[OUTCOMES[v.outcome]]) + 1;
        r.watchSeconds = round1(num(r.watchSeconds) + v.watched);
        r.avgWatchSeconds = round1(r.watchSeconds / n);
        r.completionRate = round1(num(r.fullViews) * 100 / n);
        r.updated = t;
    });
    changed.forEach(r => saveRow('Videos', r));

    // Running totals per viewer
    const d = { views: views.length, watchSeconds: 0 };
    views.forEach(v => { d.watchSeconds += v.watched; d[OUTCOMES[v.outcome]] = (d[OUTCOMES[v.outcome]] || 0) + 1; });
    const clip = (k, n) => String(p[k] || '').slice(0, n);
    bumpUser(user, d, session, {
        device: clip('device', 20), os: clip('os', 20), browser: clip('browser', 30),
        language: clip('language', 20), timezone: clip('timezone', 50), referrer: clip('referrer', 100)
    });
    return views.length;
}
function cleanEvent(e) {
    if (!e || typeof e !== 'object') return null;
    const folder = String(e.f || '').trim().slice(0, 100), video = String(e.v || '').trim().slice(0, 200);
    if (!folder || !video || !has(OUTCOMES, e.o)) return null;
    return { folder, video, outcome: e.o, watched: clamp(e.w, 36000), duration: clamp(e.d, 36000), percent: clamp(e.p, 100) };
}
// Adds the counts in d to the viewer's row (creating it), counts a new visit for a new session and keeps device info
function bumpUser(user, d, session, info) {
    const t = now();
    const r = rows('Users').filter(x => x.user === user)[0] || { user, firstSeen: t };
    Object.keys(d).forEach(k => { r[k] = Math.max(0, round1(num(r[k]) + d[k])); });
    if (session && session !== r.lastSession) { r.visits = num(r.visits) + 1; r.lastSession = session; }
    Object.keys(info || {}).forEach(k => { if (info[k] && !(k === 'referrer' && r.referrer)) r[k] = info[k]; }); // keep the first referrer
    r.lastSeen = t;
    saveRow('Users', r);
}

// ---------- Responses ----------
// { "<video>": { likes, comments, shares, views, liked } } for every video in the folder that has any activity
function folderStats(folder, user) {
    const stats = {};
    const get = (v) => stats[v] || (stats[v] = { likes: 0, comments: 0, shares: 0, views: 0, liked: false });
    rows('Likes').forEach(r => { if (r.folder === folder) { const s = get(r.video); s.likes++; if (user && r.user === user) s.liked = true; } });
    rows('Comments').forEach(r => { if (r.folder === folder) get(r.video).comments++; });
    rows('Shares').forEach(r => { if (r.folder === folder) get(r.video).shares++; });
    rows('Videos').forEach(r => { if (r.folder === folder) get(r.video).views = num(r.views); });
    return stats;
}
function videoStat(folder, video, user) {
    return folderStats(folder, user)[video] || { likes: 0, comments: 0, shares: 0, views: 0, liked: false };
}
function commentList(folder, video, user) {
    return rows('Comments')
        .filter(r => r.folder === folder && r.video === video)
        .map(r => ({ id: r.id, name: r.name, text: r.text, created: isoOf(r.created), mine: !!user && r.user === user }));
}

// ---------- Time ----------
function stamp(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm:ss z'); }
// "2026-11-13 11:21:04 CST" -> "2026-11-13T11:21:04-06:00", which browsers can read (comment times)
function isoOf(s) {
    const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (CST|CDT)$/.exec(s);
    return m ? m[1] + 'T' + m[2] + (m[3] === 'CDT' ? '-05:00' : '-06:00') : s;
}
// Older rows were saved as UTC ISO strings ("2026-11-13T17:21:04.378Z"); turn them into Central time
function toCentral(v) {
    if (v instanceof Date) return stamp(v);
    const s = String(v === null || v === undefined ? '' : v);
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/.test(s)) {
        const d = new Date(s);
        if (!isNaN(d.getTime())) return stamp(d);
    }
    return s;
}
// Converts every timestamp column in every tab. Runs once by itself (the first request after deploying);
// it can also be run by hand from the Apps Script editor, and running it again changes nothing.
function convertTimestampsToCentral() {
    const ss = book();
    Object.keys(TABS).forEach(name => {
        const sh = ss.getSheetByName(name);
        if (!sh || sh.getLastRow() < 2) return;
        TABS[name].forEach((c, j) => {
            if (TIME_COLS.indexOf(c) < 0) return;
            const range = sh.getRange(2, j + 1, sh.getLastRow() - 1, 1);
            const vals = range.getValues();
            range.setNumberFormat('@').setValues(vals.map(r => [toCentral(r[0])]));
        });
    });
}
function migrateTimestamps() {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('timestampsTz') === TZ) return;
    convertTimestampsToCentral();
    props.setProperty('timestampsTz', TZ);
}

// ---------- Sheet helpers ----------
function book() { return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet(); }

function sheet(name) {
    const ss = book();
    let sh = ss.getSheetByName(name);
    if (!sh) {
        const cols = TABS[name];
        sh = ss.insertSheet(name);
        sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
        // Text columns stay plain text (so names like "2024-05-01" are not turned into dates); counts stay numbers
        cols.forEach((c, j) => { if (NUMBERS.indexOf(c) < 0) sh.getRange(1, j + 1, sh.getMaxRows(), 1).setNumberFormat('@'); });
        sh.setFrozenRows(1);
    }
    return sh;
}

function rows(name) {
    const sh = sheet(name), cols = TABS[name];
    const last = sh.getLastRow();
    if (last < 2) return [];
    return sh.getRange(2, 1, last - 1, cols.length).getValues().map((vals, i) => {
        const o = { _row: i + 2 };
        cols.forEach((c, j) => {
            const v = vals[j];
            o[c] = v instanceof Date ? v.toISOString() : String(v === null ? '' : v);
        });
        return o;
    }).filter(o => o[cols[0]]);
}

// A leading = + - @ would make the sheet treat a comment as a formula; the apostrophe keeps it as text
function safe(v) { v = v === undefined || v === null ? '' : String(v); return /^[=+\-@]/.test(v) ? "'" + v : v; }
function cell(col, v) { return NUMBERS.indexOf(col) >= 0 ? num(v) : safe(v); }
function insert(name, obj) { sheet(name).appendRow(TABS[name].map(c => safe(obj[c]))); }
// Writes an object back to its row (from rows()), or adds it as a new row
function saveRow(name, obj) {
    const cols = TABS[name], vals = cols.map(c => cell(c, obj[c]));
    if (obj._row) sheet(name).getRange(obj._row, 1, 1, cols.length).setValues([vals]);
    else sheet(name).appendRow(vals);
}

function need(o, k) {
    if (o[k] === undefined || String(o[k]).trim() === '') throw new Error('Missing ' + k);
    return String(o[k]).trim();
}
function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
function round1(v) { return Math.round(v * 10) / 10; }
function clamp(v, hi) { return round1(Math.min(hi, Math.max(0, num(v)))); }
function now() { return stamp(new Date()); }
function newId() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
