// Runs Whisper off the main thread for word-timed transcripts (voices are
// handled by speaker-worker.js). Models download once from the
// Hugging Face Hub and are cached by the browser; audio never leaves the device.
//
// Everything runs on WebAssembly with 8-bit weights. That is the smallest
// download (about 40 MB for Fast, 77 MB for Balanced) and works the same on
// every phone and desktop browser; the GPU builds are 2–3x bigger to download.

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
import { normalizePeak } from './cloud-words.js';

env.allowLocalModels = false;

// Count the bytes that actually arrive, so the page can tell a slow download
// from a stalled one. (Progress events alone can pause while bytes still flow.)
let openDownloads = 0;
let bytesIn = 0;
const baseFetch = env.fetch || fetch;
env.fetch = async (url, opts) => {
  const res = await baseFetch(url, opts);
  if (!res.body || typeof TransformStream === 'undefined') return res;
  openDownloads++;
  let closed = false;
  const close = () => { if (!closed) { closed = true; openDownloads--; } };
  const counter = new TransformStream({
    transform(chunk, ctrl) { bytesIn += chunk.byteLength; ctrl.enqueue(chunk); },
    flush: close,
  });
  const body = res.body.pipeThrough(counter);
  body.closed?.catch?.(close);
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
};
setInterval(() => self.postMessage({ type: 'beat', open: openDownloads, bytes: bytesIn }), 2000);

const SR = 16000;
let asr = null;
let asrModel = null;
const post = (msg) => self.postMessage(msg);

function progress(kind) {
  return (p) => {
    if (p.status === 'progress' || p.status === 'download' || p.status === 'done') {
      post({ type: 'download', kind, file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0, status: p.status });
    }
  };
}

async function loadASR(model) {
  if (asr && asrModel === model) return asr;
  post({ type: 'status', text: 'Loading speech model…' });
  asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback: progress('speech') });
  asrModel = model;
  return asr;
}

const rms = (a) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
};

/** Split into ≤28 s pieces, cutting at the quietest moment near each boundary. */
function cutPoints(samples) {
  const maxLen = 28 * SR, search = 4 * SR, win = Math.round(0.05 * SR);
  const cuts = [0];
  let pos = 0;
  while (samples.length - pos > maxLen) {
    let best = pos + maxLen, bestE = Infinity;
    for (let i = pos + maxLen - search; i < pos + maxLen; i += win) {
      const e = rms(samples.subarray(i, i + win));
      if (e < bestE) { bestE = e; best = i + (win >> 1); }
    }
    cuts.push(best);
    pos = best;
  }
  cuts.push(samples.length);
  return cuts;
}

async function transcribe({ samples, model, language }) {
  const run = await loadASR(model);
  samples = normalizePeak(samples); // quiet phone recordings get a lift
  const cuts = cutPoints(samples);
  // Skip only pieces that are near-silent compared with the whole track, so a
  // quietly recorded video is still transcribed.
  const silent = Math.min(0.002, Math.max(0.0003, rms(samples) * 0.04));
  const words = [];
  const total = cuts.length - 1;
  const multilingual = !/\.en_/.test(model);
  for (let i = 0; i < total; i++) {
    const piece = samples.subarray(cuts[i], cuts[i + 1]);
    const offset = cuts[i] / SR;
    post({ type: 'status', text: total > 1 ? `Transcribing part ${i + 1} of ${total}…` : 'Transcribing…' });
    post({ type: 'transcribe-progress', done: i, total });
    if (rms(piece) < silent) continue; // near-silence: Whisper tends to hallucinate here
    const opts = { return_timestamps: 'word' };
    if (multilingual) {
      opts.task = 'transcribe';
      if (language && language !== 'auto') opts.language = language;
    }
    const out = await run(piece, opts);
    for (const c of out.chunks || []) {
      const [s, e] = c.timestamp || [];
      words.push({
        text: c.text,
        timestamp: [Number.isFinite(s) ? s + offset : null, Number.isFinite(e) ? e + offset : null],
      });
    }
    post({ type: 'partial', chunks: words.slice() });
  }
  post({ type: 'transcribe-progress', done: total, total });
  return words;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'transcribe') post({ id, type: 'result', chunks: await transcribe(data) });
  } catch (e) {
    post({ id, type: 'error', message: e?.message || String(e) });
  }
};
