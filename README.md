# Reels

Instagram-style reels for every folder under `data/`. Each folder gets its own link, its videos play full-screen one after another (auto-scrolling to the next when one ends, and starting over after the last), and viewers can like, comment on and share each video. Titles, descriptions and hashtags come from the file names, and viewers can filter by hashtag. Static site (GitHub Pages friendly) with a Google Sheet as the backend, same setup as get-together.

## Add videos
1. Put videos in a folder under `data/`, e.g. `data/my-trip/01-beach-sunset.mp4` (mp4/webm/m4v/mov).
2. Run `node build.js`. It writes `videos.json` (folders, videos, titles, hashtags), the share pages in `r/`, and, if ffmpeg is installed, poster and preview images in `posters/`. Run it again whenever videos change, then commit and push.

### How file names become titles, descriptions and hashtags
| File name | Title | Description | Hashtags |
|---|---|---|---|
| `07-project-gazematch.mp4` | Gazematch | Project gazematch. Reel 7 of 20 in gyoridavid. | #project #gazematch |
| `03-city-walk--sunset by the river #travel.mp4` | City Walk | Sunset by the river | #city #walk #travel |

- A leading number sets the order and is dropped.
- Words found in **every** file of a folder (like `project`) stay as a hashtag but are left out of titles.
- Text after `--` is used as the description; `#words` anywhere in the name are added as hashtags.

## Connect the Google Sheet (one time, ~3 minutes)
1. Create a Google Sheet (or reuse one), then **Extensions > Apps Script**.
2. Replace the editor contents with `Code.gs` from this folder and save. (If you open Apps Script from somewhere other than the sheet, paste the sheet id into `SHEET_ID`.)
3. **Deploy > New deployment > Web app**. Execute as: *Me*. Who has access: *Anyone*. Authorize when asked.
4. Copy the web app URL (ends in `/exec`) and paste it into `DEFAULT_URL` at the top of `script.js`, so everyone you share a link with can like and comment. (The "Connect" link on the home page saves it in one browser only, which is handy for testing.)

Tabs `Likes`, `Comments` and `Shares` are created automatically. If you change `Code.gs` later, use **Deploy > Manage deployments > Edit > New version**.

## Run it
- Locally: `node serve.js` and open http://localhost:8000 (`node serve.js 8000 lan` to open it from a phone on the same Wi-Fi).
- Hosted: push the folder to GitHub Pages. GitHub limits each file to 100 MB and a Pages site to about 1 GB, so keep large collections elsewhere.

## Links
- `r/<folder>/`: share link for a collection, e.g. `https://suryarao.in/reels/r/gyoridavid/`
- `r/<folder>/<video name without extension>/`: share link for one reel (what the Share button sends)
- `#/<folder>?tag=xray`: only the reels with that hashtag

The `r/` pages are made by `build.js`. Chat apps and social sites don't run JavaScript or read anything after `#`, so these pages carry Open Graph tags (title, description, hashtags and a 1200x630 preview image from `posters/*.og.jpg`) for a rich preview, then send people straight into the player. The public address used in those tags defaults to `https://suryarao.in/reels/`; for another host run `node build.js --site=https://example.com/reels/`. WhatsApp and others cache previews, so a link shared before a change may keep its old preview for a while.

## Using it
- Swipe or scroll to move between reels; on desktop also use the arrow buttons or ↑/↓ keys. Space pauses, M toggles sound, L likes.
- Tap a video to pause, double-tap to like. Videos start muted (browsers require it), so tap the speaker for sound.
- Tap a hashtag under a video, or the # button, to filter. Filtered reels also auto-advance and repeat.
- No sign-in: each browser gets a random id so a like can be undone and you can delete your own comments. Your name for comments is remembered in the browser.
