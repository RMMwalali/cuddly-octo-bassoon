// Voice fingerprints for telling speakers apart. Runs WeSpeaker CAM++
// (trained on VoxCeleb, ~29 MB) with ONNX Runtime Web. Each short stretch of
// speech becomes a 512-number "voice print"; the page then groups prints that
// sound like the same person (clusterVoices in cwi.js).

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.bundle.min.mjs';
import { fbank } from './fbank.js';

const MODEL_URL = 'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/wespeaker_en_voxceleb_CAM%2B%2B.onnx';
const CACHE = 'rc-models-v1';
const SR = 16000;
const MIN_SECONDS = 0.7;

ort.env.wasm.numThreads = 1; // no SharedArrayBuffer on static hosts without COOP/COEP
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

let session = null;
let open = 0, bytes = 0;
const post = (m) => self.postMessage(m);
setInterval(() => post({ type: 'beat', open, bytes }), 2000);

async function fetchModel() {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  const hit = cache && (await cache.match(MODEL_URL));
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  post({ type: 'status', text: 'Loading voice model…' });
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Voice model download failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 29_300_000;
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  open++;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      bytes += value.length;
      post({ type: 'download', kind: 'voice', file: 'voice.onnx', loaded, total, status: 'progress' });
    }
  } finally {
    open--;
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  post({ type: 'download', kind: 'voice', file: 'voice.onnx', loaded, total: loaded, status: 'done' });
  try { await cache?.put(MODEL_URL, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch {}
  return buf;
}

async function load() {
  if (session) return session;
  const model = await fetchModel();
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return session;
}

async function embed({ samples, units }) {
  const s = await load();
  const inName = s.inputNames[0], outName = s.outputNames[0];
  const vectors = [];
  for (let i = 0; i < units.length; i++) {
    if (i % 4 === 0) post({ type: 'embed-progress', done: i, total: units.length });
    const u = units[i];
    if (u.end - u.start < MIN_SECONDS) { vectors.push(null); continue; }
    const a = Math.max(0, Math.floor((u.start - 0.05) * SR));
    const b = Math.min(samples.length, Math.ceil((u.end + 0.05) * SR));
    const feats = fbank(samples.subarray(a, b), { window: 'hamming' }); // WeSpeaker's training features
    if (feats.frames < 40) { vectors.push(null); continue; }
    const input = new ort.Tensor('float32', feats.data, [1, feats.frames, feats.bins]);
    const out = await s.run({ [inName]: input });
    const v = Float32Array.from(out[outName].data);
    let n = 0;
    for (let k = 0; k < v.length; k++) n += v[k] * v[k];
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < v.length; k++) v[k] /= n;
    vectors.push(v);
  }
  post({ type: 'embed-progress', done: units.length, total: units.length });
  return vectors;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'embed') post({ id, type: 'result', vectors: await embed(data) });
  } catch (e) {
    post({ id, type: 'error', message: e?.message || String(e) });
  }
};
