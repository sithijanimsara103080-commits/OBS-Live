# Cloud OBS Studio (local)

A small OBS-style studio that runs on your own PC. Build a scene from your
images, videos, logos and text, then push it to YouTube Live over RTMP.
Everything is configured from the web UI — no GitHub secrets, no cloud.

```
node server.js  ->  http://127.0.0.1:3000
```

Double-click **`start-studio.bat`** (or run `node server.js`). It creates its
own `data/` and `media/` folders on first run.

## Open the UI from GitHub

**https://sithijanimsara103080-commits.github.io/OBS-Live/**

The same UI is published to GitHub Pages on every push. Open it anywhere, then
start `start-studio.bat` on your PC — the page finds the local server
automatically and the header badge switches to **LOCAL**. If it says there is no
server, press **Retry** after starting it.

> Browsers block a public web page from calling `127.0.0.1` until you allow it.
> If the badge stays **WEB**, click **Allow** on Chrome's *“wants to access
> devices on your local network”* prompt, or just press **Open local studio**
> (`http://127.0.0.1:3000`) — same app, no permission needed.

The **Cloud** tab starts/stops the GitHub Actions stream (Zoom → YouTube) with a
GitHub token (`Actions: read and write`); the token is kept in your browser
only.

## What you can do

| Feature | How |
|---|---|
| Add images / logos / photos | Sources → **Drop files here** or **+ Image / Logo** |
| Add videos | **+ Video**, or drag a file onto the drop zone |
| Text overlay | **+ Text**, edit it in the inspector |
| Solid colour / background | **+ Colour**, or set *Background colour* in Settings |
| Screen / window capture | **+ Screen / Window** (type the exact window title in the inspector) |
| Move / resize | drag on the preview, drag the blue corner handle |
| Opacity, volume, mute | inspector under the preview |
| Reorder layers | the layer strip under the preview, or ↑/↓ in the inspector |
| Delete | inspector **Delete** or the `Delete` key |
| Nudge | arrow keys (`Shift` = 10 px) |
| Go live | Stream tab → RTMP URL + stream key → **Go live** |
| Apply scene changes while live | **Apply live** (rebuilds the encoder, ~2 s) |

## Going live

1. YouTube Studio → **Go live** → **Stream** → copy the **stream key**.
2. Studio → **Stream** tab:
   - RTMP URL: `rtmp://a.rtmp.youtube.com/live2`
   - Stream key: paste it
   - (optional) Zoom link — just saved for reference
3. **Go live**.

Settings survive restarts in `studio/data/settings.json`; the scene lives in
`studio/data/scene.json`; uploads go to `studio/media/`.

## How it works

The scene is composited by **ffmpeg**, not by screen capture, so it is sharp and
uses very little CPU:

```
colour background (WxH)
  + image layers    (-loop 1)
  + video layers    (-stream_loop -1, audio mixed in)
  + text layers     (drawtext, transparent background)
  + screen layers   (gdigrab)
        |
   overlay chain -> libx264 -> RTMP
```

Audio = the audio of every unmuted video layer, mixed with a silent track so
YouTube always receives a valid audio stream.

## Notes / limits

- Portrait / other ratios: type a custom resolution in *Settings*; the stage
  follows it.
- **Screen / window capture** uses Windows `gdigrab`. GPU-accelerated windows
  (some browsers, some games) can capture as black — a normal application
  window works best.
- While live, moving a layer only changes the **preview** until you press
  **Apply live**; each apply restarts the encoder for ~2 seconds.
- 1280x720 @ 30 fps / 2500 kbps is a safe default. A weak PC should use the
  `ultrafast` preset.
- This app only streams from files/your screen. It does not join Zoom meetings
  by itself — that is what the cloud workflow in the repository root does.

## Files

| File | Purpose |
|---|---|
| `server.js` | HTTP server, settings/scene storage, uploads, stream control |
| `lib/ffmpeg.js` | builds the ffmpeg filter graph from the scene |
| `public/` | the studio UI |
| `data/`, `media/` | created at runtime, git-ignored |
