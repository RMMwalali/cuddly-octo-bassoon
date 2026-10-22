// Runs the AI models off the main thread: Whisper for word-timed transcripts and
// pyannote segmentation for who is speaking when. Models download once from the
// Hugging Face Hub and are cached by the browser; audio never leaves the device.
//
// Everything runs on WebAssembly with 8-bit weights. That is the smallest
// download (about 40 MB for Fast, 77 MB for Balanced) and works the same on
// every phone and desktop browser; the GPU builds are 2–3x bigger to download.

import {
  pipeline, env, AutoProcessor, AutoModelForAudioFrameClassification,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

env.allowLocalModels = false;

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

const DIARIZER = 'onnx-community/pyannote-segmentation-3.0';
const POWERSET_TO_SPEAKER = [0, 1, 2, 3, 1, 1, 2];
let diarizer = null;

/**
 * Per-window speaker labels, in 10 s windows every 5 s (what the model was
 * trained on, and flat memory however long the video is). The main thread
 * stitches the windows into one timeline (stitchDiarization in cwi.js).
 */
async function diarize({ samples }) {
  if (!diarizer) {
    post({ type: 'status', text: 'Loading speaker model…' });
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(DIARIZER, { progress_callback: progress('speaker') }),
      AutoModelForAudioFrameClassification.from_pretrained(DIARIZER, { device: 'wasm', dtype: 'fp32', progress_callback: progress('speaker') }),
    ]);
    diarizer = { processor, model };
  }
  const win = 10 * SR, hop = 5 * SR;
  const starts = [];
  for (let s = 0; ; s += hop) {
    starts.push(s);
    if (s + win >= samples.length) break;
  }
  const windows = [];
  for (let k = 0; k < starts.length; k++) {
    post({ type: 'status', text: 'Finding who is speaking…' });
    post({ type: 'diarize-progress', done: k, total: starts.length });
    const piece = samples.subarray(starts[k], Math.min(samples.length, starts[k] + win));
    if (piece.length < SR * 0.5) break;
    const inputs = await diarizer.processor(piece);
    const { logits } = await diarizer.model(inputs);
    const [, F, C] = logits.dims;
    const data = logits.data;
    const frames = new Int8Array(F);
    for (let f = 0; f < F; f++) {
      let best = 0, bv = -Infinity;
      for (let c = 0; c < C; c++) { const v = data[f * C + c]; if (v > bv) { bv = v; best = c; } }
      frames[f] = POWERSET_TO_SPEAKER[best] ?? 0;
    }
    windows.push({ start: starts[k] / SR, frameDur: piece.length / SR / F, frames });
  }
  post({ type: 'diarize-progress', done: starts.length, total: starts.length });
  return windows;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'transcribe') post({ id, type: 'result', chunks: await transcribe(data) });
    else if (type === 'diarize') post({ id, type: 'result', windows: await diarize(data) });
  } catch (e) {
    post({ id, type: 'error', message: e?.message || String(e) });
  }
};
