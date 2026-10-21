// Exports: .cwi.json (OpenCaptions format), styled .ass that plays the CWI
// animation in VLC/mpv/ffmpeg, .vtt with speaker voice tags, plain .srt, and a
// burned-in video rendered in the browser.

import { CWI, toCWIDocument } from './cwi.js';
import { POSITIONS, TEXT_SIZES } from './renderer.js';
import { getFont, fontWeight } from './fonts.js';

export function formatTime(sec, sep = '.') {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}${sep}${pad(ms % 1000, 3)}`;
}

function rows(project) {
  const byId = new Map(project.words.map((w) => [w.id, w]));
  const cast = new Map(project.cast.map((s) => [s.id, s]));
  return project.captions.map((c) => ({ ...c, words: c.wordIds.map((id) => byId.get(id)).filter(Boolean), who: cast.get(c.speaker) }));
}

/** Plain subtitles. With several speakers, a new speaker's first line is prefixed "Name:". */
export function toSRT(project) {
  const multi = project.cast.length > 1;
  let last = null;
  return rows(project).map((c, i) => {
    const prefix = multi && c.speaker !== last && c.who ? `${c.who.name}: ` : '';
    last = c.speaker;
    return `${i + 1}\n${formatTime(c.start, ',')} --> ${formatTime(c.end, ',')}\n${prefix}${c.words.map((w) => w.text).join(' ')}\n`;
  }).join('\n');
}

/** WebVTT with <v Speaker> tags, per-word timing and bold emphasis. */
export function toVTT(project) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cues = rows(project).map((c) => {
    const text = c.words.map((w, i) => {
      const t = w.emphasis ? `<b>${esc(w.text)}</b>` : esc(w.text);
      return i === 0 ? t : `<${formatTime(w.start)}>${t}`;
    }).join(' ');
    const v = c.who ? `<v ${esc(c.who.name)}>` : '';
    return `${formatTime(c.start)} --> ${formatTime(c.end)}\n${v}${text}\n`;
  });
  return `WEBVTT\n\n${cues.join('\n')}`;
}

export function toCWIJSON(project, meta) {
  return JSON.stringify(toCWIDocument(project, meta), null, 2) + '\n';
}

// ASS colors are &HBBGGRR (alpha separate).
const bgr = (hex) => { const h = hex.replace('#', ''); return `${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };
const assTime = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assEsc = (s) => s.replace(/\\/g, '＼').replace(/\{/g, '(').replace(/\}/g, ')');

/**
 * Advanced SubStation Alpha that plays the CWI animation: per-word Roboto Flex
 * weight (\\b) and size (\\fs), white -> speaker color over 600 ms (\\t), and
 * the 15% emphasis bounce. Burn in with: ffmpeg -i in.mp4 -vf subtitles=captions.ass out.mp4
 */
export function toASS(project, { width = 1080, height = 1920, position = 'bottom', textSize = 'medium', backing = 'outline', names = false, font: fontId } = {}) {
  const font = getFont(fontId);
  const base = Math.min(width, height) * (TEXT_SIZES[textSize] || TEXT_SIZES.medium);
  const y = Math.round(height * (POSITIONS[position] ?? POSITIONS.bottom));
  const box = backing === 'box';
  const anim = CWI.ANIMATION_MS;
  const half = Math.round(anim / 2);
  const bounce = Math.round(100 * (1 + CWI.BOUNCE));
  const head = `[Script Info]
; Caption with Intention styling, made with Reactive Captions
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CWI,${font.family},${Math.round(base)},&H00FFFFFF,&H00FFFFFF,${box ? '&H241A1A1A' : '&H1A000000'},${box ? '&H241A1A1A' : '&H80000000'},0,0,0,0,100,100,0,0,${box ? 3 : 1},${box ? Math.round(base * 0.2) : Math.max(1, Math.round(base * 0.07))},${box ? 0 : Math.round(base * 0.04)},5,${Math.round(width * 0.07)},${Math.round(width * 0.07)},40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = rows(project).map((c) => {
    const color = bgr(c.who?.color || '#FFFFFF');
    const parts = c.words.map((w) => {
      const t0 = Math.max(0, Math.round((w.start - c.start) * 1000));
      let tags = `\\b${fontWeight(font, w.weight)}\\fs${Math.round(base * w.size)}\\1c&HFFFFFF&\\t(${t0},${t0 + anim},\\1c&H${color}&)`;
      if (w.emphasis) tags += `\\t(${t0},${t0 + half},\\fscx${bounce}\\fscy${bounce})\\t(${t0 + half},${t0 + anim},\\fscx100\\fscy100)`;
      return `{${tags}}${assEsc(w.text)}`;
    });
    const label = names && c.who ? `{\\b600\\fs${Math.round(base * 0.5)}\\1c&H${color}&}${assEsc(c.who.name)}\\N` : '';
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},CWI,${assEsc(c.who?.name || '')},0,0,0,,{\\an5\\pos(${Math.round(width / 2)},${y})}${label}${parts.join(' ')}`;
  });
  return head + lines.join('\n') + '\n';
}

export function download(name, data, type = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function pickRecorderType() {
  const types = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

/**
 * Play the video once in real time, drawing frame + captions to a canvas and
 * recording it with the original audio. Resolves to { blob, ext }.
 */
export async function burnIn(srcUrl, draw, { onProgress, signal, maxSide = 1920 } = {}) {
  const video = document.createElement('video');
  video.src = srcUrl;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('Could not load the video for export.')); });
  const k = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((video.videoWidth * k) / 2) * 2;
  canvas.height = Math.round((video.videoHeight * k) / 2) * 2;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(30);
  const actx = new AudioContext();
  const dest = actx.createMediaStreamDestination();
  actx.createMediaElementSource(video).connect(dest);
  dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));

  const mimeType = pickRecorderType();
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));

  const paint = () => {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    draw(ctx, video.currentTime);
    onProgress?.(video.currentTime / (video.duration || 1));
  };
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    paint();
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  };
  const stop = () => { if (!stopped) { stopped = true; paint(); setTimeout(() => rec.state !== 'inactive' && rec.stop(), 150); } };
  signal?.addEventListener('abort', () => { video.pause(); stop(); });
  video.onended = stop;

  paint();
  rec.start(500);
  await actx.resume();
  await video.play();
  loop();
  await done;
  actx.close();
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  const type = mimeType.split(';')[0] || 'video/webm';
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
}
