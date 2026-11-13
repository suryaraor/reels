#!/usr/bin/env node
// Tiny local web server with byte-range support (videos need it to seek and to start quickly).
//   node serve.js            -> http://localhost:8000
//   node serve.js 9000       -> another port
//   node serve.js 8000 lan   -> also reachable from phones on the same Wi-Fi
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8000;
const HOST = process.argv.includes('lan') ? '0.0.0.0' : '127.0.0.1';
const ROOT = __dirname;
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg'
};

http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
        const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (!m || (!m[1] && !m[2])) {
            res.writeHead(200, { ...headers, 'Content-Length': st.size });
            return req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
        }
        let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
        let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
        return req.method === 'HEAD' ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
    });
}).listen(PORT, HOST, () => console.log(`Reels running at http://localhost:${PORT}`));
