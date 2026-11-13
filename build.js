#!/usr/bin/env node
// Scans data/<folder>/ for videos and builds everything the static site needs. Run it again whenever videos change:
//   node build.js
// It writes:
//   videos.json                  folders, videos, and each video's title / description / hashtags (from the file name)
//   posters/<folder>/<name>.jpg  small poster for the player and home page            (needs ffmpeg)
//   posters/<folder>/<name>.og.jpg  1200x630 link-preview image (frame on a blurred background)
//   r/<folder>/index.html, r/<folder>/<name>/index.html
//                                share pages: Open Graph tags so WhatsApp, iMessage, Slack, X, LinkedIn... show a
//                                preview with picture, title and hashtags; people opening them go straight to the reel.
// Options: --no-posters, --site=https://example.com/reels/  (or REELS_SITE=...) for the public address of the site.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const POSTERS = path.join(ROOT, 'posters');
const SHARE = path.join(ROOT, 'r');
const EXT = /\.(mp4|webm|m4v|mov|ogv)$/i;
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' };
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
let SITE = arg('site') || process.env.REELS_SITE || 'https://suryarao.in/reels/';
if (!SITE.endsWith('/')) SITE += '/';
const wantPosters = !process.argv.includes('--no-posters');
const hasFfmpeg = wantPosters && spawnSync('ffmpeg', ['-version']).status === 0;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const urlPath = (...parts) => parts.map(encodeURIComponent).join('/');

// ---------- File name -> title, description, hashtags ----------
// "07-project-gazematch.mp4"                      -> title "Gazematch", tags #project #gazematch
// "03-city-walk--sunset by the river #travel.mp4" -> title "City Walk", description "Sunset by the river", tags #city #walk #travel
// Leading numbers set the order and are dropped. Words found in every file of the folder (like "project")
// become a shared hashtag and are left out of the titles.
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'is', 'it', 'my', 'our', 'your', 'final', 'copy', 'edit', 'v1', 'v2', 'v3']);
const cap = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);
const splitWords = (s) => s.split(/[\s._-]+/).filter(Boolean);
const tagOf = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');

function describe(folderName, files) {
    const parsed = files.map((file) => {
        const stem = file.replace(EXT, '');
        const explicit = (stem.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => tagOf(t.slice(1)));
        const [main, ...rest] = stem.replace(/#[\p{L}\p{N}_]+/gu, ' ').split(/--|__/);
        const num = /^\s*(\d+)[\s._-]*/.exec(main);
        return { file, stem, explicit, words: splitWords(num ? main.slice(num[0].length) : main), desc: splitWords(rest.join(' ')).join(' ') };
    });
    const sets = parsed.map((p) => new Set(p.words.map((w) => w.toLowerCase())));
    const common = parsed.length > 1 ? [...sets[0]].filter((w) => sets.every((s) => s.has(w))) : [];
    return parsed.map((p, i) => {
        const own = p.words.filter((w) => !common.includes(w.toLowerCase()));
        const title = (own.length ? own : p.words).map(cap).join(' ') || p.stem;
        const sentence = cap(p.words.join(' ').toLowerCase());
        const description = p.desc ? cap(p.desc) : `${sentence}. Reel ${i + 1} of ${parsed.length} in ${folderName}.`;
        const tags = [...new Set([...p.words.map(tagOf), ...p.explicit])].filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));
        return { file: p.file, stem: p.stem, title, description, tags };
    });
}

// ---------- Images ----------
let made = 0;
function ffmpeg(args, out, what) {
    if (!hasFfmpeg || fs.existsSync(out)) return fs.existsSync(out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, out]);
    if (r.status === 0) { made++; return true; }
    console.warn(`  ${what} failed: ${String(r.stderr).trim().split('\n').pop()}`);
    return false;
}
// The frame at 1s, sized to 360px wide for the player
const poster = (src, out) => ffmpeg(['-ss', '1', '-i', src, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5'], out, 'Poster');
// 1200x630 card: the frame centred over a blurred, darkened copy of itself (works for vertical and wide videos)
const ogImage = (src, out) => ffmpeg(['-ss', '1', '-i', src, '-frames:v', '1', '-filter_complex',
    '[0:v]split[a][b];[a]scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630,boxblur=24:2,eq=brightness=-0.18[bg];' +
    '[b]scale=-2:630:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2', '-q:v', '4'], out, 'Preview image');
const probe = (src) => {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src]);
    const [w, h] = String(r.stdout || '').trim().split(',').map(Number);
    return w && h ? { width: w, height: h } : null;
};

// ---------- Share pages ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function sharePage({ title, description, image, video, url, target }) {
    const meta = [
        ['og:type', video ? 'video.other' : 'website'], ['og:site_name', 'Reels'], ['og:title', title], ['og:description', description], ['og:url', url],
        ...(image ? [['og:image', image], ['og:image:secure_url', image], ['og:image:type', 'image/jpeg'], ['og:image:width', '1200'], ['og:image:height', '630'], ['og:image:alt', title]] : []),
        ...(video ? [['og:video', video.url], ['og:video:secure_url', video.url], ['og:video:type', video.type],
            ...(video.width ? [['og:video:width', String(video.width)], ['og:video:height', String(video.height)]] : [])] : [])
    ];
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${meta.map(([p, c]) => `<meta property="${p}" content="${esc(c)}">`).join('\n')}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">\n` : ''}<link rel="canonical" href="${esc(url)}">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<script>try{sessionStorage.setItem('reels_ref',document.referrer)}catch(e){}location.replace(${JSON.stringify(target)} + location.search);</script>
<style>body{font-family:system-ui,sans-serif;background:#14110e;color:#faf7f0;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#ff8a65}</style>
</head>
<body><p>Opening <a href="${esc(target)}">${esc(title)}</a>…</p></body>
</html>
`;
}

// ---------- Build ----------
if (!fs.existsSync(DATA)) { console.error('No data/ folder next to build.js'); process.exit(1); }
if (wantPosters && !hasFfmpeg) console.warn('ffmpeg not found: skipping poster and preview images.');
fs.rmSync(SHARE, { recursive: true, force: true }); // share pages are regenerated from scratch

const folders = fs.readdirSync(DATA, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort(collator.compare)
    .map((name) => {
        const files = fs.readdirSync(path.join(DATA, name)).filter((f) => EXT.test(f)).sort(collator.compare);
        const videos = describe(name, files).map((v) => {
            const src = path.join(DATA, name, v.file);
            const out = { ...v, src: urlPath('data', name, v.file) };
            if (poster(src, path.join(POSTERS, name, `${v.stem}.jpg`))) out.poster = urlPath('posters', name, `${v.stem}.jpg`);
            if (ogImage(src, path.join(POSTERS, name, `${v.stem}.og.jpg`))) out.ogImage = urlPath('posters', name, `${v.stem}.og.jpg`);
            out.share = `r/${urlPath(name, v.stem)}/`;
            const size = hasFfmpeg ? probe(src) : null;
            const hashtags = v.tags.map((t) => '#' + t).join(' ');
            fs.mkdirSync(path.join(SHARE, name, v.stem), { recursive: true });
            fs.writeFileSync(path.join(SHARE, name, v.stem, 'index.html'), sharePage({
                title: `${v.title} · ${name}`,
                description: `${v.description} ${hashtags}`.trim(),
                image: out.ogImage ? SITE + out.ogImage : '',
                video: { url: SITE + out.src, type: MIME[path.extname(v.file).slice(1).toLowerCase()] || 'video/mp4', ...(size || {}) },
                url: SITE + out.share,
                target: `../../../#/${urlPath(name, v.stem)}`
            }));
            return out;
        });
        return { name, share: `r/${urlPath(name)}/`, videos };
    })
    .filter((f) => f.videos.length);

// One page per folder, previewed with its first reel
folders.forEach((f) => {
    const counts = {};
    f.videos.forEach((v) => v.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([t]) => '#' + t);
    const first = f.videos[0];
    fs.writeFileSync(path.join(SHARE, f.name, 'index.html'), sharePage({
        title: `${f.name} · ${f.videos.length} reels`,
        description: `Watch ${f.videos.length} reels: ${f.videos.slice(0, 4).map((v) => v.title).join(', ')}${f.videos.length > 4 ? '…' : ''} ${top.join(' ')}`,
        image: first.ogImage ? SITE + first.ogImage : '',
        url: SITE + f.share,
        target: `../../#/${urlPath(f.name)}`
    }));
});

fs.writeFileSync(path.join(ROOT, 'videos.json'), JSON.stringify({ generated: new Date().toISOString(), site: SITE, folders }, null, 1));
folders.forEach((f) => console.log(`  ${f.name}: ${f.videos.length} videos`));
console.log(`Wrote videos.json and share pages for ${SITE} (${folders.length} folders${made ? `, ${made} new images` : ''}).`);
