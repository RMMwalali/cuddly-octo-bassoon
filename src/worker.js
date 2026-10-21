// Runs the AI models off the main thread: Whisper for word-timed transcripts and
// an AudioSet classifier for non-speech sounds. Models download once from the
// Hugging Face Hub and are cached by the browser; audio never leaves the device.

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

env.allowLocalModels = false;

const SR = 16000;
const pipes = new Map();
const post = (msg) => self.postMessage(msg);

function progress(kind) {
  return (p) => {
    if (p.status === 'progress' || p.status === 'download' || p.status === 'done') {
      post({ type: 'download', kind, file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0, status: p.status });
    }
  };
}

async function hasWebGPU() {
  try {
    return !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(task, model, kind) {
  const key = `${task}:${model}`;
  if (pipes.has(key)) return pipes.get(key);
  const gpu = await hasWebGPU();
  const tries = gpu
    ? [
        { device: 'webgpu', dtype: task === 'automatic-speech-recognition' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'fp32' },
        { device: 'wasm', dtype: 'q8' },
      ]
    : [{ device: 'wasm', dtype: 'q8' }];
  let lastErr;
  for (const opts of tries) {
    try {
      post({ type: 'status', text: `Loading ${kind} model (${opts.device === 'webgpu' ? 'GPU' : 'CPU'})…` });
      const p = await pipeline(task, model, { ...opts, progress_callback: progress(kind) });
      pipes.set(key, p);
      post({ type: 'device', kind, device: opts.device });
      return p;
    } catch (e) {
      lastErr = e;
      console.warn(`[worker] ${model} on ${opts.device} failed`, e);
    }
  }
  throw lastErr;
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
  const asr = await load('automatic-speech-recognition', model, 'speech');
  const cuts = cutPoints(samples);
  const words = [];
  const total = cuts.length - 1;
  const multilingual = !/\.en_/.test(model);
  for (let i = 0; i < total; i++) {
    const piece = samples.subarray(cuts[i], cuts[i + 1]);
    const offset = cuts[i] / SR;
    post({ type: 'status', text: total > 1 ? `Transcribing part ${i + 1} of ${total}…` : 'Transcribing…' });
    post({ type: 'transcribe-progress', done: i, total });
    if (rms(piece) < 0.002) continue; // near-silence: Whisper tends to hallucinate here
    const opts = { return_timestamps: 'word' };
    if (multilingual) {
      opts.task = 'transcribe';
      if (language && language !== 'auto') opts.language = language;
    }
    const out = await asr(piece, opts);
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

async function tagSounds({ samples }) {
  const clf = await load('audio-classification', 'Xenova/ast-finetuned-audioset-10-10-0.4593', 'sound');
  const win = 2 * SR, hop = 1 * SR;
  const windows = [];
  const steps = Math.max(1, Math.ceil((samples.length - win) / hop) + 1);
  for (let k = 0; k < steps; k++) {
    const s = k * hop;
    const piece = samples.subarray(s, Math.min(samples.length, s + win));
    if (piece.length < SR * 0.5) break;
    if (rms(piece) < 0.003) continue;
    const labels = await clf(piece, { top_k: 12 });
    windows.push({ start: s / SR, end: (s + piece.length) / SR, labels });
    if (k % 3 === 0) post({ type: 'tag-progress', done: k + 1, total: steps });
  }
  post({ type: 'tag-progress', done: steps, total: steps });
  return windows;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'transcribe') post({ id, type: 'result', chunks: await transcribe(data) });
    else if (type === 'tag') post({ id, type: 'result', windows: await tagSounds(data) });
  } catch (e) {
    post({ id, type: 'error', message: e?.message || String(e) });
  }
};
