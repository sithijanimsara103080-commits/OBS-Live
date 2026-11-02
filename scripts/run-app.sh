#!/usr/bin/env bash
# Cloud stream using the Zoom DESKTOP client (bypasses the "automated bots" block
# the web client gets). Captures the X display + the virtual sink audio.
set -uo pipefail

export DISPLAY="${DISPLAY:-:99}"
VIDEO_SIZE="${VIDEO_SIZE:-1280x720}"
SCREEN="${SCREEN:-${VIDEO_SIZE}x24}"
AUDIO_SINK="${AUDIO_SINK:-virtual_speaker}"
DURATION_MIN="${DURATION_MIN:-345}"
export SHOTS_DIR="${SHOTS_DIR:-/tmp/shots}"
ZOOM_BIN="${ZOOM_BIN:-/opt/zoom/zoom}"

log() { echo "[app $(date -u +%H:%M:%S)] $*"; }
mkdir -p "$SHOTS_DIR"

if [ -z "${YT_RTMP:-}" ]; then log "FATAL: YT_RTMP is not set"; exit 2; fi
case "$YT_RTMP" in
  rtmp://*|rtmps://*) : ;;
  *) YT_RTMP="rtmp://a.rtmp.youtube.com/live2/${YT_RTMP}" ;;
esac
if [ -z "${ZOOM_LINK:-}" ]; then log "FATAL: ZOOM_LINK is not set"; exit 2; fi

ID=$(printf '%s' "$ZOOM_LINK" | sed -n 's#.*/[jsw]/\([0-9][0-9]*\).*#\1#p')
[ -z "$ID" ] && ID=$(printf '%s' "$ZOOM_LINK" | sed -n 's#[^0-9]*\([0-9]\{9,12\}\).*#\1#p')
PWD_=$(printf '%s' "$ZOOM_LINK" | sed -n 's#.*[?&]pwd=\([^&#]*\).*#\1#p')
NAME="${ZOOM_NAME:-Live}"
log "meeting id=$ID pwd=${PWD_:+set} name=$NAME"
[ -z "$ID" ] && { log "FATAL: could not read the meeting id"; exit 2; }

cleanup() {
  log "cleanup"
  [ -n "${STREAM_PID:-}" ] && kill "$STREAM_PID" 2>/dev/null
  [ -n "${ZOOM_PID:-}" ] && kill "$ZOOM_PID" 2>/dev/null
  [ -n "${WM_PID:-}" ] && kill "$WM_PID" 2>/dev/null
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null
  sleep 1
  pkill -f 'ffmpeg.*x11grab' 2>/dev/null
  pkill -f '/opt/zoom' 2>/dev/null
  pulseaudio --kill 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# ---------------------------------------------------------------- Xvfb
log "starting Xvfb $DISPLAY ($SCREEN)"
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -ac +extension RANDR +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 2
if ! kill -0 "$XVFB_PID" 2>/dev/null; then log "FATAL: Xvfb died"; cat /tmp/xvfb.log; exit 1; fi

# window manager so dialogs get focused (Enter key needs a focused window)
if command -v openbox >/dev/null 2>&1; then
  openbox >/tmp/wm.log 2>&1 &
  WM_PID=$!
  sleep 1
fi

# ---------------------------------------------------------- PulseAudio
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
log "starting PulseAudio"
pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit --log-target=file:/tmp/pulse.log || true
for i in $(seq 1 20); do pactl info >/dev/null 2>&1 && break; sleep 0.5; done
pactl info >/dev/null 2>&1 || { log "FATAL: PulseAudio did not start"; cat /tmp/pulse.log; exit 1; }
pactl load-module module-null-sink sink_name="$AUDIO_SINK" \
      sink_properties=device.description=VirtualSpeaker >/dev/null 2>&1 || log "null sink already loaded"
pactl set-default-sink "$AUDIO_SINK" >/dev/null 2>&1 || true
pactl set-sink-volume "$AUDIO_SINK" 100% >/dev/null 2>&1 || true
pactl list short sinks || true
export PULSE_SINK="$AUDIO_SINK"

# ------------------------------------------------------------- ffmpeg
stream_loop() {
  while true; do
    log "starting ffmpeg -> youtube"
    ffmpeg -hide_banner -loglevel warning -nostdin \
      -thread_queue_size 1024 \
      -f x11grab -draw_mouse 0 -framerate 30 -video_size "$VIDEO_SIZE" -i "$DISPLAY" \
      -thread_queue_size 1024 \
      -f pulse -i "$AUDIO_SINK.monitor" \
      -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
      -filter_complex "[1:a][2:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]" \
      -map 0:v -map "[aout]" \
      -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
      -profile:v main -level 3.1 -g 60 -keyint_min 60 -sc_threshold 0 \
      -b:v 2500k -maxrate 2500k -bufsize 5000k -r 30 \
      -c:a aac -b:a 128k -ar 44100 -ac 2 \
      -flvflags no_duration_filesize \
      -f flv "$YT_RTMP"
    log "ffmpeg exited ($?), restarting in 5s"
    sleep 5
  done
}

shot() { ffmpeg -hide_banner -loglevel error -f x11grab -video_size "$VIDEO_SIZE" -i "$DISPLAY" -frames:v 1 -y "$SHOTS_DIR/$1.png" >/dev/null 2>&1 || true; }

report() {
  [ -x ../scripts/report.sh ] || [ -x scripts/report.sh ] || return 0
  local r="scripts/report.sh"; [ -x "$r" ] || r="../scripts/report.sh"
  {
    echo "phase=$1 t=${elapsed}s joined=$joined"
    echo "zoom_pid=${ZOOM_PID:-none} alive=$(kill -0 "${ZOOM_PID:-0}" 2>/dev/null && echo yes || echo no)"
    echo "ffmpeg=$(pgrep -f 'ffmpeg.*x11grab' >/dev/null && echo running || echo dead)"
    echo "--- windows ---"
    for w in $(xdotool search --onlyvisible --name '.' 2>/dev/null | head -15); do
      echo "[$w] $(xdotool getwindowname "$w" 2>/dev/null)"
    done
    echo "--- zoom.log ---"
    tail -n 25 /tmp/zoom.log 2>/dev/null
    echo "--- ffmpeg/pulse ---"
    tail -n 5 /tmp/pulse.log 2>/dev/null
  } > /tmp/report.txt 2>&1
  GH_TOKEN="${GH_TOKEN:-}" bash "$r" "$(cat /tmp/report.txt)" >/dev/null 2>&1 || true
}

join_url="zoommtg://zoom.us/join?action=join&confno=$ID&uname=$NAME"
[ -n "$PWD_" ] && join_url="$join_url&pwd=$PWD_"

press_join_buttons() {
  # name field is pre-filled; Enter accepts the default "Join" button
  xdotool key --clearmodifiers Return >/dev/null 2>&1
  # "Join Audio by Computer" dialog
  for w in $(xdotool search --onlyvisible --name 'Join Audio' 2>/dev/null); do
    xdotool windowactivate --sync "$w" >/dev/null 2>&1
    xdotool key --clearmodifiers Return >/dev/null 2>&1
  done
}

launch_zoom() {
  log "launching Zoom client"
  export LD_LIBRARY_PATH="/opt/zoom:/opt/zoom/lib:${LD_LIBRARY_PATH:-}"
  export QT_QPA_PLATFORM=xcb
  if [ -x /opt/zoom/zoom.sh ]; then
    /opt/zoom/zoom.sh "$join_url" >/tmp/zoom.log 2>&1 &
  else
    "$ZOOM_BIN" "$join_url" >/tmp/zoom.log 2>&1 &
  fi
  ZOOM_PID=$!
  ldd "$ZOOM_BIN" 2>/dev/null | grep 'not found' | head -5 >>/tmp/zoom.log
}

in_meeting() {
  xdotool search --onlyvisible --name 'Zoom Meeting' >/dev/null 2>&1 ||
  xdotool search --onlyvisible --name 'Zoom Workplace' >/dev/null 2>&1
}

END=$(( $(date +%s) + DURATION_MIN * 60 ))
stream_loop & STREAM_PID=$!

launch_zoom
elapsed=0
joined=0
while [ "$(date +%s)" -lt "$END" ]; do
  sleep 4
  elapsed=$((elapsed + 4))
  press_join_buttons
  if in_meeting; then
    if [ "$joined" = 0 ]; then
      joined=1
      log "joined the meeting (window visible)"
      shot joined
      # maximise the meeting window
      w=$(xdotool search --onlyvisible --name 'Zoom Meeting' | head -1)
      [ -n "$w" ] && { xdotool windowmove "$w" 0 0; xdotool windowsize "$w" 1280 720; xdotool windowactivate "$w"; }
    fi
  else
    if [ "$joined" = 1 ] && [ "$elapsed" -gt 30 ]; then
      if [ $((elapsed % 60)) -lt 4 ]; then
        log "meeting window gone - relaunching client"
        shot lost
        kill "$ZOOM_PID" 2>/dev/null
        sleep 3
        launch_zoom
        joined=0
      fi
    fi
  fi
  if [ $((elapsed % 30)) -lt 4 ]; then shot "t${elapsed}"; fi
  if [ $((elapsed % 20)) -lt 4 ]; then report "running"; fi
done

log "time is up"
cleanup
