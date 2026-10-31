#!/usr/bin/env bash
# Xvfb + PulseAudio + ffmpeg supervisor + Zoom bot.
# Usage:  YT_RTMP=rtmp://... ZOOM_LINK=https://zoom.us/j/... ./scripts/run.sh
set -uo pipefail

export DISPLAY="${DISPLAY:-:99}"
VIDEO_SIZE="${VIDEO_SIZE:-1280x720}"
SCREEN="${SCREEN:-${VIDEO_SIZE}x24}"
AUDIO_SINK="${AUDIO_SINK:-virtual_speaker}"
DURATION_MIN="${DURATION_MIN:-345}"
MAX_RUN_MIN="${MAX_RUN_MIN:-$DURATION_MIN}"
export MAX_RUN_MIN
export SHOTS_DIR="${SHOTS_DIR:-/tmp/shots}"
export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"

log() { echo "[run $(date -u +%H:%M:%S)] $*"; }

if [ -z "${YT_RTMP:-}" ]; then
  log "FATAL: YT_RTMP is not set"
  exit 2
fi
case "$YT_RTMP" in
  rtmp://*|rtmps://*) : ;;
  *) YT_RTMP="rtmp://a.rtmp.youtube.com/live2/${YT_RTMP}" ;;
esac

if [ -z "${ZOOM_LINK:-}" ]; then
  log "FATAL: ZOOM_LINK is not set"
  exit 2
fi

cleanup() {
  log "cleanup"
  [ -n "${STREAM_PID:-}" ] && kill "$STREAM_PID" 2>/dev/null
  [ -n "${BOT_PID:-}" ] && kill "$BOT_PID" 2>/dev/null
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null
  sleep 1
  pkill -f 'ffmpeg.*x11grab' 2>/dev/null
  pkill -f 'google-chrome' 2>/dev/null
  pulseaudio --kill 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# ---------------------------------------------------------------- Xvfb
log "starting Xvfb $DISPLAY ($SCREEN)"
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -ac +extension RANDR +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 2
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  log "FATAL: Xvfb died"; cat /tmp/xvfb.log; exit 1
fi

# ---------------------------------------------------------- PulseAudio
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
log "starting PulseAudio"
pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit --log-target=file:/tmp/pulse.log || true
for i in $(seq 1 20); do
  pactl info >/dev/null 2>&1 && break
  sleep 0.5
done
pactl info >/dev/null 2>&1 || { log "FATAL: PulseAudio did not start"; cat /tmp/pulse.log; exit 1; }
pactl load-module module-null-sink sink_name="$AUDIO_SINK" \
      sink_properties=device.description=VirtualSpeaker >/dev/null 2>&1 \
  || log "null sink already loaded"
pactl load-module module-remap-source master="$AUDIO_SINK.monitor" \
      source_name=virtmic source_properties=device.description=VirtualMic >/dev/null 2>&1 \
  || log "remap source already loaded"
pactl set-default-sink "$AUDIO_SINK" >/dev/null 2>&1 || true
pactl set-default-source virtmic >/dev/null 2>&1 || true
pactl set-sink-volume "$AUDIO_SINK" 100% >/dev/null 2>&1 || true
pactl list short sinks || true

# Chrome must play audio into our virtual sink so ffmpeg can record it.
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

bot_loop() {
  while true; do
    log "starting zoom bot"
    node bot.js
    log "bot exited ($?), restarting in 10s"
    sleep 10
  done
}

END=$(( $(date +%s) + DURATION_MIN * 60 ))
stream_loop & STREAM_PID=$!
bot_loop & BOT_PID=$!

log "live for up to ${DURATION_MIN} minutes"
while [ "$(date +%s)" -lt "$END" ]; do
  if ! kill -0 "$STREAM_PID" 2>/dev/null; then
    log "stream loop died"
    break
  fi
  sleep 15
done

log "time is up"
cleanup
