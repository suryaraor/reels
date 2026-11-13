#!/usr/bin/env node
// Scans data/<folder>/ for videos and writes videos.json (a static site cannot list folders by itself).
// Run it again whenever you add, rename or remove videos:   node build.js
// With ffmpeg installed it also saves a small poster image per video in posters/ (skip with --no-posters).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const POSTERS = path.join(ROOT, 'posters');
const EXT = /\.(mp4|webm|m4v|mov|ogv)$/i;
const wantPosters = !process.argv.includes('--no-posters');
const hasFfmpeg = wantPosters && spawnSync('ffmpeg', ['-version']).status === 0;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const urlPath = (...parts) => parts.map(encodeURIComponent).join('/');

if (!fs.existsSync(DATA)) { console.error('No data/ folder next to build.js'); process.exit(1); }
if (wantPosters && !hasFfmpeg) console.warn('ffmpeg not found: skipping poster images.');

let made = 0;
const folders = fs.readdirSync(DATA, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort(collator.compare)
    .map((name) => {
        const files = fs.readdirSync(path.join(DATA, name)).filter((f) => EXT.test(f)).sort(collator.compare);
        const videos = files.map((file) => {
            const v = { file, src: urlPath('data', name, file) };
            const posterName = file.replace(EXT, '.jpg');
            const out = path.join(POSTERS, name, posterName);
            if (hasFfmpeg && !fs.existsSync(out)) {
                fs.mkdirSync(path.dirname(out), { recursive: true });
                const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', path.join(DATA, name, file),
                    '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', out]);
                if (r.status === 0) made++;
                else console.warn(`Poster failed for ${name}/${file}`);
            }
            if (fs.existsSync(out)) v.poster = urlPath('posters', name, posterName);
            return v;
        });
        return { name, videos };
    })
    .filter((f) => f.videos.length);

fs.writeFileSync(path.join(ROOT, 'videos.json'), JSON.stringify({ generated: new Date().toISOString(), folders }, null, 1));
folders.forEach((f) => console.log(`  ${f.name}: ${f.videos.length} videos`));
console.log(`Wrote videos.json (${folders.length} folders${made ? `, ${made} new posters` : ''}).`);
