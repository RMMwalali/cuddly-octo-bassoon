// Audio feature extraction. Pure functions over mono Float32Array samples,
// so they run the same in the browser, in a worker, and in Node tests.

export const TARGET_RATE = 16000;

/** Decode any audio/video file the browser can play into 16 kHz mono samples. */
export async function decodeToMono16k(fileOrBuffer) {
  const buf = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    ctx.close?.();
  }
  const length = Math.ceil(decoded.duration * TARGET_RATE);
  const offline = new OfflineAudioContext(1, Math.max(1, length), TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0), sampleRate: TARGET_RATE, duration: decoded.duration };
}

const toDb = (rms) => 20 * Math.log10(rms + 1e-9);

/** Loudness of a span in dB: 80th percentile of 20 ms frame RMS (robust to soft word edges). */
export function spanLoudnessDb(samples, sampleRate, start, end) {
  const s = Math.max(0, Math.floor(start * sampleRate));
  const e = Math.min(samples.length, Math.ceil(end * sampleRate));
  if (e - s < 16) return -100;
  const frame = Math.max(16, Math.round(0.02 * sampleRate));
  const vals = [];
  for (let i = s; i < e; i += frame) {
    const j = Math.min(e, i + frame);
    let sum = 0;
    for (let k = i; k < j; k++) sum += samples[k] * samples[k];
    vals.push(toDb(Math.sqrt(sum / (j - i))));
  }
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.8))];
}

/**
 * Fundamental frequency of one frame by normalized autocorrelation.
 * Returns { hz, clarity } — clarity near 1 means clearly voiced.
 */
export function framePitch(samples, offset, size, sampleRate, minHz = 70, maxHz = 450) {
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.min(Math.floor(sampleRate / minHz), size - 1);
  let energy = 0;
  for (let i = 0; i < size; i++) energy += samples[offset + i] ** 2;
  if (energy < 1e-6) return { hz: 0, clarity: 0 };
  let bestLag = -1;
  let best = 0;
  const corr = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < size; i++) {
      const a = samples[offset + i], b = samples[offset + i + lag];
      c += a * b; e1 += a * a; e2 += b * b;
    }
    const r = c / (Math.sqrt(e1 * e2) + 1e-12);
    corr[lag] = r;
  }
  // First strong peak avoids octave errors from later, slightly higher peaks.
  let globalMax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) globalMax = Math.max(globalMax, corr[lag]);
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] >= 0.9 * globalMax && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      bestLag = lag; best = corr[lag]; break;
    }
  }
  if (bestLag < 0) return { hz: 0, clarity: 0 };
  // Parabolic interpolation for sub-sample lag.
  const y0 = corr[bestLag - 1], y1 = corr[bestLag], y2 = corr[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  return { hz: sampleRate / (bestLag + shift), clarity: best };
}

/** Median voiced pitch (Hz) across a span, or 0 if the span is unvoiced. */
export function spanPitchHz(samples, sampleRate, start, end) {
  const size = Math.round(0.04 * sampleRate);
  const hop = Math.round(0.02 * sampleRate);
  const s = Math.max(0, Math.floor(start * sampleRate));
  const e = Math.min(samples.length - size, Math.floor(end * sampleRate) - size);
  const hz = [];
  // At most 8 frames per word keeps long videos fast.
  const step = Math.max(hop, Math.floor((e - s) / 8));
  for (let i = s; i <= e; i += step) {
    const p = framePitch(samples, i, size, sampleRate);
    if (p.clarity > 0.6 && p.hz > 0) hz.push(p.hz);
  }
  if (!hz.length) return 0;
  hz.sort((a, b) => a - b);
  return hz[Math.floor(hz.length / 2)];
}

/** Per-word acoustic features used by the reaction engine. */
export function wordFeatures(words, samples, sampleRate) {
  return words.map((w) => ({
    db: spanLoudnessDb(samples, sampleRate, w.start, w.end),
    hz: spanPitchHz(samples, sampleRate, w.start, w.end),
  }));
}

/** Coarse loudness envelope (one value per `step` seconds), for the timeline waveform. */
export function envelope(samples, sampleRate, step = 0.05) {
  const n = Math.max(1, Math.ceil(samples.length / (step * sampleRate)));
  const out = new Float32Array(n);
  const win = Math.round(step * sampleRate);
  for (let b = 0; b < n; b++) {
    let peak = 0;
    const end = Math.min(samples.length, (b + 1) * win);
    for (let i = b * win; i < end; i++) peak = Math.max(peak, Math.abs(samples[i]));
    out[b] = peak;
  }
  return out;
}
