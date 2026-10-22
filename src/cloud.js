// Fast path: compress the speech track on the device, send it to our own
// /api/transcribe function, get words (and speakers) back in seconds.
// Anything that goes wrong returns null-ish errors so the page can fall back
// to on-device Whisper.

import { LANG_CODES } from './cloud-words.js';

let probe = null;

/** Is cloud transcription set up on this deployment? Cached per page load. */
export function cloudAvailable() {
  if (probe) return probe;
  probe = (async () => {
    if (!/^https?:$/.test(location.protocol)) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch('/api/transcribe', { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) return null;
      const info = await res.json();
      return info?.ok ? info : null;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  })();
  return probe;
}

/** 16 kHz mono float samples -> MP3 bytes, in a worker. */
export function encodeMp3(samples, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./mp3-worker.js', import.meta.url), { type: 'module' });
    const done = () => { w.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort);
    w.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress?.(data.done / Math.max(1, data.total));
      else if (data.type === 'result') { done(); resolve(data.mp3); }
      else if (data.type === 'error') { done(); reject(new Error(data.message)); }
    };
    w.onerror = (e) => { done(); reject(new Error(e.message || 'MP3 encoder failed to start')); };
    const copy = samples.slice();
    w.postMessage({ id: 1, samples: copy, sampleRate: 16000 }, [copy.buffer]);
  });
}

/**
 * Transcribe in the cloud. Resolves to
 * `{ provider, language, speakers, words: [{ text, start, end, speaker? }] }`.
 */
export async function cloudTranscribe(samples, { language, speakers = true, signal, onStatus, maxBytes = 4_400_000 } = {}) {
  onStatus?.('Compressing audio…', 0);
  const mp3 = await encodeMp3(samples, { signal, onProgress: (f) => onStatus?.(null, f * 0.3) });
  if (mp3.length > maxBytes) throw new Error('This video is too long for fast mode.');
  onStatus?.('Transcribing in the cloud…', 0.35);
  const q = new URLSearchParams();
  const code = LANG_CODES[language];
  if (code) q.set('language', code);
  if (!speakers) q.set('speakers', '0');
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, 120_000);
  try {
    const res = await fetch(`/api/transcribe?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/mpeg' },
      body: mp3,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Cloud transcription failed (${res.status}).`);
    if (!Array.isArray(data?.words)) throw new Error('Cloud transcription returned nothing.');
    return data;
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
