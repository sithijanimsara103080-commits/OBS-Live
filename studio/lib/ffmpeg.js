'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function filterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function resolveSrc(src, mediaDir) {
  if (!src) return null;
  if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('\\\\')) return src;
  const clean = src.replace(/^media[\\/]/, '');
  return path.join(mediaDir, clean);
}

function hasAudio(file, ffprobe) {
  try {
    const out = execFileSync(
      ffprobe,
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
      { encoding: 'utf8', windowsHide: true }
    ).trim();
    return out.length > 0;
  } catch (_) {
    return false;
  }
}

function hex(color) {
  let c = String(color || '#000000').replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(c)) c = '000000';
  return c;
}

/**
 * Build the ffmpeg argv for a scene.
 * opts: { settings, scene, rtmp|output, mediaDir, ffprobePath, textDir, duration }
 */
function buildFfmpegArgs(opts) {
  const settings = opts.settings || {};
  const scene = opts.scene || { layers: [] };
  const mediaDir = opts.mediaDir;
  const ffprobe = opts.ffprobePath || 'ffprobe';
  const textDir = opts.textDir || path.join(process.cwd(), 'data', 'tmp');
  const out = opts.output || opts.rtmp;

  const W = Math.round(settings.width || 1280);
  const H = Math.round(settings.height || 720);
  const FPS = Math.round(settings.fps || 30);
  const BR = Math.round(settings.bitrate || 2500);

  fs.mkdirSync(textDir, { recursive: true });

  const inputs = [];
  const filters = [];
  const audio = [];
  const warnings = [];

  inputs.push(['-re', '-f', 'lavfi', '-i', `color=c=0x${hex(scene.background)}:s=${W}x${H}:r=${FPS}`]);
  filters.push('[0:v]format=rgba[base]');

  let last = 'base';
  let n = 0;
  let textSeq = 0;

  for (const l of scene.layers || []) {
    if (l.visible === false) continue;
    const alpha = Math.max(0, Math.min(1, (l.opacity == null ? 100 : l.opacity) / 100));
    const x = Math.round(l.x || 0);
    const y = Math.round(l.y || 0);
    const w = Math.max(2, Math.round(l.w || W));
    const h = Math.max(2, Math.round(l.h || H));
    const idx = inputs.length;

    try {
      if (l.type === 'image' || l.type === 'video') {
        const file = resolveSrc(l.src, mediaDir);
        if (!file || !fs.existsSync(file)) {
          warnings.push(`missing file for layer ${l.id}: ${l.src}`);
          continue;
        }
        if (l.type === 'image') {
          inputs.push(['-re', '-loop', '1', '-framerate', String(FPS), '-i', file]);
        } else {
          inputs.push(['-re', '-stream_loop', '-1', '-i', file]);
        }

        const label = `l${n}`;
        const prefix = l.type === 'video' ? 'setpts=PTS-STARTPTS,' : '';
        filters.push(
          `[${idx}:v]${prefix}fps=${FPS},scale=${w}:${h},format=rgba` +
            (alpha < 1 ? `,colorchannelmixer=aa=${alpha}` : '') +
            `[${label}]`
        );

        if (l.type === 'video' && !l.muted && hasAudio(file, ffprobe)) {
          const vol = Math.max(0, Math.min(100, l.volume == null ? 100 : l.volume)) / 100;
          audio.push({ idx, vol });
        }
      } else if (l.type === 'color') {
        inputs.push(['-re', '-f', 'lavfi', '-i', `color=c=0x${hex(l.color)}:s=${w}x${h}:r=${FPS}`]);
        const label = `l${n}`;
        filters.push(
          `[${idx}:v]format=rgba` + (alpha < 1 ? `,colorchannelmixer=aa=${alpha}` : '') + `[${label}]`
        );
      } else if (l.type === 'screen') {
        const src = l.window ? ['-i', `title=${l.window}`] : ['-i', 'desktop'];
        inputs.push(['-f', 'gdigrab', '-framerate', String(FPS), ...src]);
        const label = `l${n}`;
        filters.push(
          `[${idx}:v]fps=${FPS},scale=${w}:${h},format=rgba` +
            (alpha < 1 ? `,colorchannelmixer=aa=${alpha}` : '') +
            `[${label}]`
        );
      } else if (l.type === 'text') {
        const tf = path.join(textDir, `text_${process.pid}_${textSeq++}.txt`);
        fs.writeFileSync(tf, String(l.text == null ? '' : l.text), 'utf8');
        inputs.push(['-re', '-f', 'lavfi', '-i', `color=c=black@0.0:s=${w}x${h}:r=${FPS},format=rgba`]);
        const label = `l${n}`;
        const font = filterPath(l.fontFile || 'C:/Windows/Fonts/arialbd.ttf');
        const size = Math.max(8, Math.round(l.fontSize || 48));
        filters.push(
          `[${idx}:v]format=rgba,drawtext=fontfile='${font}':textfile='${filterPath(tf)}'` +
            `:fontcolor=0x${hex(l.fontColor || '#ffffff')}` +
            `:fontsize=${size}:x=(w-text_w)/2:y=(h-text_h)/2` +
            (alpha < 1 ? `,colorchannelmixer=aa=${alpha}` : '') +
            `[${label}]`
        );
      } else {
        continue;
      }

      filters.push(
        `[${last}][l${n}]overlay=x=${x}:y=${y}:format=auto:shortest=0:repeatlast=1[o${n}]`
      );
      last = `o${n}`;
      n++;
    } catch (e) {
      warnings.push(`layer ${l.id}: ${e.message}`);
    }
  }

  // ---- audio -------------------------------------------------------
  const anull = inputs.length;
  inputs.push(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']);

  const mix = [`[${anull}:a]`];
  audio.forEach((a, i) => {
    filters.push(`[${a.idx}:a]aresample=async=1:first_pts=0,volume=${a.vol.toFixed(2)}[a${i}]`);
    mix.push(`[a${i}]`);
  });
  filters.push(
    `${mix.join('')}amix=inputs=${mix.length}:duration=longest:dropout_transition=0:normalize=0[aout]`
  );
  filters.push(`[${last}]format=yuv420p[outv]`);

  const args = [];
  for (const i of inputs) args.push(...i);
  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[outv]', '-map', '[aout]');
  args.push(
    '-c:v', 'libx264',
    '-preset', settings.preset || 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-g', String(FPS * 2),
    '-keyint_min', String(FPS * 2),
    '-sc_threshold', '0',
    '-b:v', `${BR}k`,
    '-maxrate', `${BR}k`,
    '-bufsize', `${BR * 2}k`,
    '-r', String(FPS),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-stats',
    '-stats_period', '3'
  );

  if (opts.duration) args.push('-t', String(opts.duration));

  if (opts.output) {
    args.push('-y', opts.output);
  } else {
    args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', opts.rtmp);
  }

  return { args, warnings, layerCount: n };
}

module.exports = { buildFfmpegArgs, resolveSrc, filterPath };
