# Cloud OBS 24/7 — Zoom → YouTube

Joins a Zoom meeting in a headless Chromium (Zoom **web client**), captures the
screen + meeting audio with `ffmpeg`, and pushes it to YouTube Live over RTMP.
Runs on GitHub Actions and keeps itself alive 24/7 with a self-dispatch chain.

```
GitHub Actions (ubuntu)
 ├─ Xvfb :99                    virtual 1280x720 screen
 ├─ PulseAudio + null sink      virtual speaker (meeting audio)
 ├─ Google Chrome + Playwright  joins the Zoom web client
 ├─ ffmpeg (x11grab + pulse)    screen + audio -> rtmp://a.rtmp.youtube.com/live2/KEY
 └─ bot.js                     keeps the meeting joined, rejoins on drop
```

`index.html` is a real control panel: it calls the GitHub API to start / stop
the workflow and show live status.

---

## Setup (10 minutes)

### 1. YouTube

1. YouTube Studio → **Go live** → **Stream** → copy the **Stream key**.
2. In the stream settings set latency to **Normal** (low latency drops frames on
   this setup).

### 2. Repo secrets

Repository → **Settings → Secrets and variables → Actions**:

| Type | Name | Value |
|---|---|---|
| Secret | `YT_RTMP` | `rtmp://a.rtmp.youtube.com/live2/YOUR-KEY` (or just `YOUR-KEY`) |
| Secret | `ZOOM_LINK` | `https://zoom.us/j/1234567890?pwd=abcd` |
| Secret | `GH_PAT` | optional — a PAT with `workflow` scope, enables the 24/7 chain |
| Variable | `AUTO_RESTART` | `true` to enable the self-dispatch chain |
| Variable | `ZOOM_NAME` | the display name the bot joins with (e.g. `Live`) |

> Use a **fine-grained PAT** limited to this repo with *Actions: read & write*,
> or a classic PAT with `workflow` scope.

### 3. Turn it on

- Push this code to the repo.
- Actions → **Cloud OBS 24/7** → *Run workflow*.
- Jobs are capped at **6 hours**, so each run streams 345 minutes and the
  workflow queues the next one before it ends (no gap).
- There is also a cron every 6 hours as a safety net; the `guard` step skips it
  if a stream is already running.

### 4. Control panel

Open `index.html` in a browser, paste a GitHub token, press **Start**.
The token never leaves your browser except to `api.github.com`, and it is stored
in `localStorage`.

---

## Running it on your own Linux box instead

Anything in `scripts/run.sh` is plain bash, so it also works on a real VPS
(Oracle Cloud Always Free, Hetzner, etc.) — that is far more reliable than
GitHub Actions:

```bash
sudo apt-get install -y ffmpeg xvfb pulseaudio pulseaudio-utils wget
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y /tmp/chrome.deb
npm install

YT_RTMP='rtmp://a.rtmp.youtube.com/live2/KEY' \
ZOOM_LINK='https://zoom.us/j/1234567890?pwd=abcd' \
DURATION_MIN=100000 \
./scripts/run.sh
```

Front it with `systemd` or `pm2` and it will survive reboots.

---

## Why the old version did not work

| Problem | Fix |
|---|---|
| workflow only did `echo` | real install + run steps |
| `x11grab -i :99` with no display | `Xvfb :99` is started first |
| `-f pulse -i default` with no PulseAudio | PulseAudio + null sink, Chrome routed into it |
| `headless: false` with no display | Xvfb, and Chrome is launched by Playwright |
| browser never joined Zoom | meeting-id parsing + web-client join flow + rejoin loop |
| `index.html` was fake | real GitHub API dispatch/cancel/status |
| no reconnect | ffmpeg restarts on exit, bot rejoins on drop |

---

## Limitations you should know (honest list)

- **Free Zoom = 40 minutes** per group meeting. When the host's meeting ends,
  the bot has nothing to stream until a new meeting starts.
- **You cannot start a meeting or push to YouTube natively on a free account**,
  so screen-capture is the only route.
- **Zoom may block datacenter IPs** or show a CAPTCHA. If that happens the run
  fails and the screenshot in the run artifacts will show the exact page.
- **GitHub Actions is not a streaming service.** A 6-hour job cap, 2–4 vCPU and
  no GPU means 720p30 is the practical ceiling, and heavy use of Actions for
  non-CI work is against GitHub's acceptable-use policy — an account ban is
  possible. A free Oracle Cloud VM avoids both problems.
- **Consent**: recording/rebroadcasting a meeting you do not host needs the
  permission of the host and participants. In many countries doing it without
  consent is illegal.
- Audio is captured from the virtual sink, so **mute notifications/tabs**; any
  sound Chrome makes goes to air.

---

## Files

| File | What it does |
|---|---|
| `bot.js` | joins/rejoins the Zoom web client and keeps the page in the meeting |
| `scripts/run.sh` | Xvfb + PulseAudio + ffmpeg supervisor + bot loop |
| `.github/workflows/live.yml` | deps, Chrome, secrets, cron, self-restart |
| `index.html` | start/stop/status control panel |
