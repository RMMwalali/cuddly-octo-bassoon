// Exports: SRT and WebVTT for platforms, ASS for editors and ffmpeg (keeps the
// reactive styling), and a burned-in video rendered in the browser.

import { PRESETS, POSITIONS, emphasisColor } from './presets.js';

export function formatTime(sec, sep = '.') {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

const byIdOf = (project) => new Map(project.words.map((w) => [w.id, w]));
const shown = (w) => (w.level === 3 ? w.text.toUpperCase() : w.text);

function cues(project) {
  const byId = byIdOf(project);
  const list = project.pages.map((p) => ({ start: p.start, end: p.end, words: p.wordIds.map((id) => byId.get(id)).filter(Boolean) }));
  for (const s of project.sounds || []) list.push({ start: s.start, end: s.end, sound: s.text });
  return list.sort((a, b) => a.start - b.start || (a.sound ? -1 : 1));
}

export function toSRT(project) {
  return cues(project)
    .map((c, i) => `${i + 1}\n${formatTime(c.start, ',')} --> ${formatTime(c.end, ',')}\n${c.sound ? `[${c.sound}]` : c.words.map(shown).join(' ')}\n`)
    .join('\n');
}

export function toVTT(project) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = cues(project).map((c) => {
    let text;
    if (c.sound) text = `[${esc(c.sound)}]`;
    else {
      text = c.words
        .map((w, i) => {
          const t = esc(shown(w));
          const word = w.level >= 2 ? `<b>${t}</b>` : t;
          return i === 0 ? word : `<${formatTime(w.start)}>${word}`;
        })
        .join(' ');
    }
    return `${formatTime(c.start)} --> ${formatTime(c.end)}\n${text}\n`;
  });
  return `WEBVTT\n\n${body.join('\n')}`;
}

// ASS colors are &HAABBGGRR (alpha 00 = opaque).
function assColor(css, alpha = 0) {
  const m = /^#?([0-9a-f]{6})$/i.exec(css || '');
  let hex = m ? m[1] : 'FFFFFF';
  let a = alpha;
  const rgba = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(css || '');
  if (rgba) {
    hex = [rgba[1], rgba[2], rgba[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
    if (rgba[4] !== undefined) a = Math.round((1 - Number(rgba[4])) * 255);
  }
  const [r, g, b] = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
  return `&H${a.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}
const assTime = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assEsc = (s) => s.replace(/\\/g, '＼').replace(/\{/g, '(').replace(/\}/g, ')');

/**
 * Advanced SubStation Alpha. One event per spoken word, so the active-word
 * highlight, emphasis sizes and mood colors play back in VLC, mpv, Aegisub,
 * and ffmpeg (`-vf subtitles=captions.ass`).
 */
export function toASS(project, { width = 1080, height = 1920, preset: presetKey = 'pop', position = 'middle', react = { size: true, color: true } } = {}) {
  const preset = PRESETS[presetKey] || PRESETS.pop;
  const base = Math.round(Math.min(width, height) * preset.size);
  const outline = Math.max(0, Math.round(base * preset.strokeW * 0.5));
  const y = Math.round(height * (POSITIONS[position] ?? POSITIONS.middle));
  const borderStyle = preset.box ? 3 : 1;
  const fill = preset.reveal === 'sweep' ? 'rgba(255,255,255,0.55)' : preset.fill;
  const head = `[Script Info]
; Made with Reactive Captions
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${preset.family},${base},${assColor(fill)},${assColor(preset.accent)},${assColor(preset.box ? '#000000' : preset.stroke)},${assColor('#000000', preset.box ? 0x60 : 0x80)},${preset.weight >= 700 ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${preset.box ? Math.round(base * 0.25) : outline},${preset.shadow ? Math.round(base * 0.05) : 0},5,40,40,40,1
Style: Sound,${preset.family},${Math.round(Math.min(width, height) * 0.032)},${assColor('#FFD23F')},${assColor('#FFD23F')},${assColor('#000000')},${assColor('#000000', 0x50)},-1,0,0,0,100,100,0,0,3,${Math.round(base * 0.12)},0,5,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const byId = byIdOf(project);
  const lines = [];
  for (const p of project.pages) {
    const ws = p.wordIds.map((id) => byId.get(id)).filter(Boolean);
    const emph = emphasisColor(preset, p.mood, react.color);
    ws.forEach((active, i) => {
      const start = i === 0 ? p.start : active.start;
      const end = i < ws.length - 1 ? ws[i + 1].start : p.end;
      if (end <= start) return;
      const parts = [];
      ws.forEach((w, j) => {
        if (preset.reveal === 'word' && j > i) return;
        const txt = assEsc(preset.upper ? w.text.toUpperCase() : shown(w));
        const scale = react.size ? Math.round((preset.scales[w.level] || 1) * 100) : 100;
        let color = null;
        if (preset.reveal === 'sweep') color = j <= i ? (w.level >= 2 && react.color ? emph : preset.accent) : null;
        else if (j === i && preset.reveal !== 'word') color = w.level >= 2 && react.color ? emph : preset.accent;
        else if (w.level >= 2 && react.color) color = emph;
        const tags = [];
        if (scale !== 100) tags.push(`\\fscx${scale}\\fscy${scale}`);
        if (color) tags.push(`\\1c&H${assColor(color).slice(4)}&\\1a&H00&`);
        parts.push(tags.length ? `{${tags.join('')}}${txt}{\\r}` : txt);
      });
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\an5\\pos(${width / 2},${y})}${parts.join(' ')}`);
    });
  }
  for (const s of project.sounds || []) {
    lines.push(`Dialogue: 1,${assTime(s.start)},${assTime(s.end)},Sound,,0,0,0,,{\\an5\\pos(${width / 2},${Math.round(Math.max(60, y - base * 1.8))})}[${assEsc(s.text)}]`);
  }
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
