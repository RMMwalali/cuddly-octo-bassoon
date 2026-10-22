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
  // iOS asks "Download?" first and only reads the blob after the tap, so keep it alive.
  setTimeout(() => URL.revokeObjectURL(a.href), 120000);
}

export const isPhone = () => matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;

/**
 * Save a finished video. On phones, the share sheet lets people "Save Video"
 * straight to Photos/Gallery or post it; elsewhere it's a normal download.
 * Must be called from a tap when using the share sheet.
 */
export async function saveVideo(name, blob) {
  const file = new File([blob], name, { type: blob.type });
  if (isPhone() && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  download(name, blob);
  return 'downloaded';
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
 * Create the export's <video> and get permission to play it with sound.
 * Call synchronously inside the Export tap: iOS only allows unmuted play()
 * that starts during a user gesture.
 */
export function primeVideo(srcUrl) {
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.src = srcUrl;
  const p = video.play();
  if (p) p.then(() => video.pause()).catch(() => {});
  return video;
}

/**
 * Play the video once in real time, drawing frame + captions to a canvas and
 * recording it with the original audio. Resolves to { blob, ext }.
 * `video` comes from primeVideo(); `actx` is an already-running AudioContext.
 */
export async function burnIn(video, actx, draw, { onProgress, signal, maxSide = 1920, bitrate = 10_000_000 } = {}) {
  if (!(video.readyState >= 1)) {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('The video took too long to load for export.')), 15000);
      video.onloadedmetadata = () => { clearTimeout(t); res(); };
      video.onerror = () => { clearTimeout(t); rej(new Error('Could not load the video for export.')); };
    });
  }
  const k = Math.min(1, maxSide / Math.max(video.videoWidth || 1080, video.videoHeight || 1920));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(((video.videoWidth || 1080) * k) / 2) * 2;
  canvas.height = Math.round(((video.videoHeight || 1920) * k) / 2) * 2;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(30);
  const dest = actx.createMediaStreamDestination();
  const source = actx.createMediaElementSource(video);
  source.connect(dest);
  dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));

  const mimeType = pickRecorderType();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: bitrate } : { videoBitsPerSecond: bitrate });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));

  let stopped = false, failure = null, lastT = -1, lastMove = performance.now();
  const paint = () => {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    draw(ctx, video.currentTime);
    onProgress?.(video.currentTime / (video.duration || 1));
  };
  const stop = (err) => {
    if (stopped) return;
    stopped = true;
    failure = err || null;
    video.pause();
    try { paint(); } catch {}
    setTimeout(() => rec.state !== 'inactive' && rec.stop(), 150);
  };
  const loop = () => {
    if (stopped) return;
    paint();
    if (video.currentTime !== lastT) { lastT = video.currentTime; lastMove = performance.now(); }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  };
  // Watchdog: if playback stops moving (decoder stall, tab hidden), fail instead of hanging.
  const watchdog = setInterval(() => {
    if (!stopped && performance.now() - lastMove > 8000) stop(new Error('Playback stalled during export. Keep the app open and on screen, then try again.'));
  }, 1000);
  const onHide = () => { if (document.hidden) stop(new Error('Export stopped because the app went to the background. Keep it on screen while exporting.')); };
  document.addEventListener('visibilitychange', onHide);
  signal?.addEventListener('abort', () => stop(new DOMException('Export cancelled', 'AbortError')));
  video.onended = () => stop();

  try {
    video.currentTime = 0;
    paint();
    rec.start(1000);
    if (actx.state !== 'running') await Promise.race([actx.resume(), new Promise((r) => setTimeout(r, 3000))]);
    await video.play();
    lastMove = performance.now();
    loop();
    await done;
  } catch (e) {
    stop(e);
    await Promise.race([done, new Promise((r) => setTimeout(r, 1000))]);
    failure = failure || e;
  } finally {
    clearInterval(watchdog);
    document.removeEventListener('visibilitychange', onHide);
    try { source.disconnect(); } catch {}
    stream.getTracks().forEach((t) => t.stop());
    video.removeAttribute('src');
    video.load();
  }
  if (failure) throw failure;
  const type = (rec.mimeType || mimeType).split(';')[0] || 'video/webm';
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
}
