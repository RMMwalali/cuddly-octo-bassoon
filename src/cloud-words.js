// Small pure helpers for the cloud transcription path (shared by the page,
// the MP3 worker and the tests).

/** The app's language names -> ISO 639-1 codes the providers expect. */
export const LANG_CODES = {
  english: 'en', swahili: 'sw', french: 'fr', arabic: 'ar', spanish: 'es',
  portuguese: 'pt', hindi: 'hi', german: 'de',
};

/** Scale so the loudest sample sits at 0.9 (quiet phone recordings get a lift). */
export function normalizePeak(samples, target = 0.9) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4 || Math.abs(peak - target) < 0.05) return samples;
  const g = Math.min(target / peak, 30);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g;
  return out;
}

/** Provider words -> the `{ text, timestamp }` chunks wordsFromWhisper reads. */
export function cloudChunks(words) {
  return (words || [])
    .filter((w) => w.text && w.text.trim() && Number.isFinite(w.start))
    .map((w) => ({ text: w.text, timestamp: [w.start, Number.isFinite(w.end) ? w.end : null] }));
}

/**
 * Provider speaker labels -> segments for assignSpeakers. When the creator
 * said how many people talk, the busiest `limit` voices are kept and the rest
 * go to whoever spoke just before them.
 */
export function cloudSegments(words, limit = null) {
  const list = (words || []).filter((w) => Number.isInteger(w.speaker) && Number.isFinite(w.start));
  if (!list.length) return [];
  let keep = null;
  if (limit) {
    const count = new Map();
    for (const w of list) count.set(w.speaker, (count.get(w.speaker) || 0) + (w.end - w.start));
    keep = new Set([...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k));
  }
  const segs = [];
  let prev = null;
  for (const w of list) {
    let id = w.speaker;
    if (keep && !keep.has(id)) id = prev ?? [...keep][0];
    prev = id;
    const last = segs[segs.length - 1];
    if (last && last.id === id + 1 && w.start - last.end < 1.5) last.end = Math.max(last.end, w.end);
    else segs.push({ id: id + 1, start: w.start, end: w.end });
  }
  return segs;
}
