// Getting 16 kHz mono audio out of whatever file a phone hands us.
//
// 1. decodeAudioData on a 16 kHz OfflineAudioContext: fast, and the browser
//    resamples while decoding, so no full-rate copy is ever made.
// 2. If the browser can't decode the container (some iPhone .mov files), play
//    the video once through Web Audio and record what comes out. Slower (real
//    time) but works anywhere the video can play.

export const TARGET_RATE = 16000;

/** Shared, gesture-unlocked AudioContext (iOS only starts audio inside a tap). */
let shared = null;
export function audioContext() {
  if (!shared || shared.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    shared = new AC();
  }
  return shared;
}
/** Call from inside a tap/click handler, before any await. */
export function unlockAudio() {
  try {
    const ctx = audioContext();
    if (ctx.state !== 'running') ctx.resume();
    // A silent one-sample buffer fully unlocks older iOS versions.
    const b = ctx.createBuffer(1, 1, ctx.sampleRate);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(0);
  } catch {}
}

function toMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  const n = buffer.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i] / n;
  }
  return out;
}

async function resample(samples, fromRate) {
  if (fromRate === TARGET_RATE) return samples;
  const len = Math.max(1, Math.ceil((samples.length * TARGET_RATE) / fromRate));
  const off = new OfflineAudioContext(1, len, TARGET_RATE);
  const buf = off.createBuffer(1, samples.length, fromRate);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

/** Fast path. Throws if the browser can't decode this file's audio. */
export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const off = new OfflineAudioContext(1, 1, TARGET_RATE);
  const decoded = await new Promise((resolve, reject) => {
    // Old Safari only supports the callback form.
    const p = off.decodeAudioData(buf, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  let samples = toMono(decoded);
  samples = await resample(samples, decoded.sampleRate); // no-op where already 16 kHz
  return { samples, sampleRate: TARGET_RATE, duration: decoded.duration };
}

/**
 * Fallback: play `videoEl` from the start through Web Audio and capture it.
 * `videoEl.play()` must already be allowed (call after a tap). Calls
 * onProgress(0..1). Resolves when the video ends.
 */
export function captureByPlayback(videoEl, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const ctx = audioContext();
    let src;
    try {
      src = videoEl.__rcSource || ctx.createMediaElementSource(videoEl);
      videoEl.__rcSource = src;
    } catch (e) { reject(e); return; }
    const proc = ctx.createScriptProcessor(4096, 2, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    const chunks = [];
    let frames = 0;
    proc.onaudioprocess = (e) => {
      if (videoEl.paused) return;
      const b = e.inputBuffer;
      const a = b.getChannelData(0);
      const out = new Float32Array(a.length);
      if (b.numberOfChannels > 1) { const c = b.getChannelData(1); for (let i = 0; i < a.length; i++) out[i] = (a[i] + c[i]) / 2; }
      else out.set(a);
      chunks.push(out);
      frames += out.length;
      onProgress?.(videoEl.currentTime / (videoEl.duration || 1));
    };
    src.disconnect();
    src.connect(proc);
    proc.connect(silent);
    silent.connect(ctx.destination);
    const finish = async (err) => {
      proc.onaudioprocess = null;
      try { proc.disconnect(); silent.disconnect(); src.disconnect(); src.connect(ctx.destination); } catch {}
      videoEl.onended = null;
      videoEl.pause();
      if (err) { reject(err); return; }
      const all = new Float32Array(frames);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      resolve({ samples: await resample(all, ctx.sampleRate), sampleRate: TARGET_RATE, duration: videoEl.duration });
    };
    signal?.addEventListener('abort', () => finish(new DOMException('Cancelled', 'AbortError')));
    videoEl.onended = () => finish();
    videoEl.currentTime = 0;
    ctx.resume().then(() => videoEl.play()).catch(finish);
  });
}
