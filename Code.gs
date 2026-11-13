// Reels backend: Google Apps Script web app that uses a Google Sheet as the database for likes, comments and shares.
// Paste this whole file into the Apps Script editor (Extensions > Apps Script) of the sheet, then
// Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone). See README.md.
//
// Three tabs are created automatically the first time the app calls it:
//   Likes    : id, folder, video, user, created
//   Comments : id, folder, video, user, name, text, created
//   Shares   : id, folder, video, user, channel, created
// "folder" is the folder name under data/, "video" is the file name without its extension,
// "user" is a random id the browser makes for itself (no sign-in).

const SHEET_ID = '1mVeDm8GZsmS3axKWfXsE3M4DqieVCNi-WRw-8Rej1eI'; // the Reels Google Sheet
const TABS = {
    Likes: ['id', 'folder', 'video', 'user', 'created'],
    Comments: ['id', 'folder', 'video', 'user', 'name', 'text', 'created'],
    Shares: ['id', 'folder', 'video', 'user', 'channel', 'created']
};

function doGet(e) {
    const p = e.parameter || {};
    let out;
    try {
        const lock = LockService.getScriptLock();
        lock.waitLock(20000);
        try { out = handle(p); } finally { lock.releaseLock(); }
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
            if (p.liked === '1' && !mine.length) insert('Likes', { id: newId(), folder, video, user, created: now() });
            if (p.liked !== '1') mine.reverse().forEach(r => sheet('Likes').deleteRow(r._row));
            return { success: true, stat: videoStat(folder, video, user) };
        }
        case 'getComments': return { success: true, comments: commentList(need(p, 'folder'), need(p, 'video'), p.user || '') };
        case 'addComment': {
            const folder = need(p, 'folder'), video = need(p, 'video'), user = need(p, 'user');
            const text = need(p, 'text').slice(0, 500);
            const name = String(p.name || '').trim().slice(0, 40) || 'Guest';
            insert('Comments', { id: newId(), folder, video, user, name, text, created: now() });
            return { success: true, comments: commentList(folder, video, user), stat: videoStat(folder, video, user) };
        }
        case 'deleteComment': {
            const user = need(p, 'user');
            const c = rows('Comments').filter(r => r.id === need(p, 'id'))[0];
            if (!c) throw new Error('Comment not found');
            if (c.user !== user) throw new Error('You can only delete your own comments');
            sheet('Comments').deleteRow(c._row);
            return { success: true, comments: commentList(c.folder, c.video, user), stat: videoStat(c.folder, c.video, user) };
        }
        case 'addShare': {
            const folder = need(p, 'folder'), video = need(p, 'video');
            insert('Shares', { id: newId(), folder, video, user: p.user || '', channel: String(p.channel || 'link').slice(0, 20), created: now() });
            return { success: true, stat: videoStat(folder, video, p.user || '') };
        }
        default: throw new Error('Unknown action');
    }
}

// ---------- Responses ----------
// { "<video>": { likes, comments, shares, liked } } for every video in the folder that has any activity
function folderStats(folder, user) {
    const stats = {};
    const get = (v) => stats[v] || (stats[v] = { likes: 0, comments: 0, shares: 0, liked: false });
    rows('Likes').forEach(r => { if (r.folder === folder) { const s = get(r.video); s.likes++; if (user && r.user === user) s.liked = true; } });
    rows('Comments').forEach(r => { if (r.folder === folder) get(r.video).comments++; });
    rows('Shares').forEach(r => { if (r.folder === folder) get(r.video).shares++; });
    return stats;
}
function videoStat(folder, video, user) {
    return folderStats(folder, user)[video] || { likes: 0, comments: 0, shares: 0, liked: false };
}
function commentList(folder, video, user) {
    return rows('Comments')
        .filter(r => r.folder === folder && r.video === video)
        .map(r => ({ id: r.id, name: r.name, text: r.text, created: r.created, mine: !!user && r.user === user }));
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
        sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@'); // keep everything as plain text
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
    }).filter(o => o.id);
}

// A leading = + - @ would make the sheet treat a comment as a formula; the apostrophe keeps it as text
function safe(v) { v = v === undefined ? '' : String(v); return /^[=+\-@]/.test(v) ? "'" + v : v; }
function insert(name, obj) { sheet(name).appendRow(TABS[name].map(c => safe(obj[c]))); }

function need(o, k) {
    if (o[k] === undefined || String(o[k]).trim() === '') throw new Error('Missing ' + k);
    return String(o[k]).trim();
}
function now() { return new Date().toISOString(); }
function newId() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
