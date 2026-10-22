// Caption with Intention engine. Pure functions, no DOM.
//
// CWI's three pillars, as this tool applies them:
//   Attribution      one color per speaker
//   Synchronization  each word turns from white to its speaker's color as it is spoken
//   Intonation       Roboto Flex weight follows pitch (low = bold, high = thin)
//                    and size follows volume (quiet = small, loud = large)
//
// Pitch and volume are measured against each speaker's own voice, so a deep
// voice is not "always bold"; only words below that person's usual pitch are.
// The document format matches OpenCaptions' .cwi.json (github.com/broomva/opencaptions).

export const CWI = {
  SCHEMA: 'https://opencaptions.tools/schema/cwi/1.0.json',
  VERSION: '1.0',
  ANIMATION_MS: 600,
  BOUNCE: 0.15,
  WEIGHT_MIN: 100,
  WEIGHT_MAX: 900,
  WEIGHT_DEFAULT: 400,
  SIZE_MIN: 0.7,
  SIZE_MAX: 1.5,
  MAX_CHARS_PER_LINE: 42,
  MAX_GAP_S: 3,
};

/** OpenCaptions' 12-color palette; each meets 4.5:1 contrast on #1a1a1a. */
export const SPEAKER_COLORS = [
  '#6B8AFF', '#FF6B6B', '#6BFFA3', '#FFD56B', '#D56BFF', '#6BF0FF',
  '#FF6BC8', '#A3FF6B', '#FF916B', '#6BB4FF', '#FFB86B', '#8A6BFF',
];

let nextId = 1;
const uid = (p) => `${p}${nextId++}`;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round = (x, step) => Math.round(x / step) * step;
const r2 = (x) => Math.round(x * 100) / 100;
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (v, p) => {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (p / 100) * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const semis = (hz) => 12 * Math.log2(hz);
const bare = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

// ---------------------------------------------------------------- words in

function makeWord(text, start, end) {
  return {
    id: uid('w'), text, start, end, speaker: 'S1',
    weight: CWI.WEIGHT_DEFAULT, size: 1, emphasis: false,
    auto: { weight: CWI.WEIGHT_DEFAULT, size: 1, emphasis: false },
    manual: {},
  };
}

function finishWords(list) {
  let last = 0;
  return list.map((w) => {
    const start = Math.max(w.start, last);
    const end = Math.max(w.end, start + 0.05);
    last = start;
    return makeWord(w.text, start, end);
  });
}

/** Whisper `return_timestamps: 'word'` chunks -> clean, monotonic words. */
export function wordsFromWhisper(chunks) {
  const out = [];
  for (const c of chunks || []) {
    const text = (c.text || '').trim();
    if (!text) continue;
    let [start, end] = c.timestamp || [];
    start = Number.isFinite(start) ? start : out.length ? out[out.length - 1].end : 0;
    end = Number.isFinite(end) ? end : start + 0.4;
    if (/^[^\p{L}\p{N}]+$/u.test(text) && out.length) {
      out[out.length - 1].text += text;
      out[out.length - 1].end = Math.max(out[out.length - 1].end, end);
      continue;
    }
    out.push({ text, start, end });
  }
  return finishWords(out);
}

/**
 * Whisper sometimes stretches the last word of a clip far past the end of the
 * audio. Keep every word inside the clip and at a sensible length.
 */
export function clampWords(words, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return words;
  for (const w of words) {
    w.start = Math.min(w.start, Math.max(0, duration - 0.05));
    w.end = Math.min(w.end, duration, w.start + 3);
    if (w.end <= w.start) w.end = Math.min(duration, w.start + 0.05);
  }
  return words;
}

/** Parse SRT or WebVTT into cues. Keeps `<v Name>` voice tags as the speaker. */
export function parseCues(src) {
  const cues = [];
  const blocks = src.replace(/\r/g, '').split(/\n{2,}/);
  const ts = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/g;
  const toSec = (m) => {
    const parts = m.split(/[:.,]/).map(Number);
    const ms = parts.pop() / 10 ** m.split(/[.,]/).pop().length;
    let s = 0;
    for (const p of parts) s = s * 60 + p;
    return s + ms;
  };
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const times = lines[i].match(ts);
    if (!times || times.length < 2) continue;
    let raw = lines.slice(i + 1).join(' ');
    const voice = /<v(?:\.[^ >]+)?\s+([^>]+)>/.exec(raw)?.[1]?.trim();
    let speaker = voice;
    raw = raw.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
    // "NAME: line" convention from SRT files
    const named = /^([A-Z][\p{L} .'-]{0,24}):\s+(.+)$/u.exec(raw);
    if (!speaker && named) { speaker = named[1].trim(); raw = named[2]; }
    if (raw) cues.push({ start: toSec(times[0]), end: toSec(times[1]), text: raw, speaker });
  }
  return cues;
}

/** Existing subtitles -> words, sharing each cue's time out by word length. */
export function wordsFromCues(cues) {
  const out = [];
  const names = [];
  for (const cue of cues) {
    const parts = cue.text.split(/\s+/).filter(Boolean);
    const weights = parts.map((p) => p.length + 2);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = cue.start;
    parts.forEach((p, i) => {
      const d = ((cue.end - cue.start) * weights[i]) / total;
      out.push({ text: p, start: t, end: t + d, name: cue.speaker });
      t += d;
    });
  }
  const words = finishWords(out);
  words.forEach((w, i) => {
    const name = out[i].name;
    if (!name) return;
    let k = names.indexOf(name);
    if (k < 0) { names.push(name); k = names.length - 1; }
    w.speaker = `S${k + 1}`;
    w.speakerName = name;
  });
  return words;
}

// ---------------------------------------------------------------- attribution

/**
 * Give each word the speaker with the most overlap.
 * `segments`: [{ id, start, end }] from pyannote-segmentation-3.0, whose
 * powerset classes are 0 none, 1-3 single speakers, 4 {1,2}, 5 {1,3}, 6 {2,3}.
 * Overlapped speech goes to the first speaker in the pair.
 */
export function assignSpeakers(words, segments, { minShare = 0.04, minWords: floor = 3, powerset = true } = {}) {
  if (!words.length) return words;
  const single = (id) => (powerset ? ({ 4: 1, 5: 1, 6: 2 })[id] ?? id : id);
  const raw = words.map((w) => {
    const score = new Map();
    for (const s of segments) {
      if (!s.id || s.end <= w.start || s.start >= w.end) continue;
      const ov = Math.min(s.end, w.end) - Math.max(s.start, w.start);
      const k = single(s.id);
      score.set(k, (score.get(k) || 0) + ov);
    }
    let best = null, bestV = 0;
    for (const [k, v] of score) if (v > bestV) { best = k; bestV = v; }
    return best;
  });
  // Unmatched words follow their neighbour.
  for (let i = 0; i < raw.length; i++) if (raw[i] == null) raw[i] = raw[i - 1] ?? raw.find((x) => x != null) ?? 1;
  // A single word flipped between two words of the same speaker is noise.
  for (let i = 1; i < raw.length - 1; i++) if (raw[i - 1] === raw[i + 1] && raw[i] !== raw[i - 1]) raw[i] = raw[i - 1];
  // Speakers with almost no words are usually misdetections: fold them into a neighbour.
  const count = new Map();
  raw.forEach((k) => count.set(k, (count.get(k) || 0) + 1));
  const minWords = Math.max(floor, Math.ceil(words.length * minShare));
  const keep = (k) => count.get(k) >= minWords;
  const major = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (let i = 0; i < raw.length; i++) {
    if (!keep(raw[i])) raw[i] = (i > 0 && keep(raw[i - 1]) ? raw[i - 1] : null) ?? raw.slice(i + 1).find(keep) ?? major;
  }
  // Renumber S1, S2… in order of first appearance.
  const order = [];
  raw.forEach((k) => { if (!order.includes(k)) order.push(k); });
  words.forEach((w, i) => { if (!w.speakerManual) w.speaker = `S${order.indexOf(raw[i]) + 1}`; });
  return words;
}

/** pyannote-segmentation-3.0 powerset class -> one local speaker (0 = nobody). */
export const POWERSET_TO_SPEAKER = [0, 1, 2, 3, 1, 1, 2];

/**
 * Join per-window speaker labels into one timeline with consistent speakers.
 * The model labels speakers 1-3 *within* each ~10 s window, and those labels
 * mean nothing across windows. Windows overlap, so each new window's speakers
 * are matched to the previous window's by how much they agree in the overlap.
 *
 * `windows`: [{ start, frameDur, frames }] sorted by start; `frames` holds a
 * local speaker (0-3) per frame. Returns [{ id, start, end }] with ids 1..N.
 */
export function stitchDiarization(windows) {
  if (!windows.length) return [];
  const maps = [];
  let nextGlobal = 1;
  windows.forEach((win, k) => {
    const map = new Map();
    if (k > 0) {
      const prev = windows[k - 1], pmap = maps[k - 1];
      const counts = new Map();
      for (let i = 0; i < win.frames.length; i++) {
        const t = win.start + (i + 0.5) * win.frameDur;
        const j = Math.floor((t - prev.start) / prev.frameDur);
        if (j < 0 || j >= prev.frames.length) continue;
        const a = win.frames[i], b = pmap.get(prev.frames[j]);
        if (!a || !b) continue;
        const key = `${a}|${b}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const used = new Set();
      [...counts.entries()].sort((x, y) => y[1] - x[1]).forEach(([key, n]) => {
        const [a, b] = key.split('|').map(Number);
        if (n < 3 || map.has(a) || used.has(b)) return;
        map.set(a, b);
        used.add(b);
      });
    }
    for (const local of win.frames) if (local && !map.has(local)) map.set(local, nextGlobal++);
    // Global ids already in use keep counting up from the highest seen.
    for (const g of map.values()) nextGlobal = Math.max(nextGlobal, g + 1);
    maps.push(map);
  });
  // Each window owns the time between the midpoints of its overlaps.
  const segs = [];
  windows.forEach((win, k) => {
    const end = win.start + win.frames.length * win.frameDur;
    const prevEnd = k > 0 ? windows[k - 1].start + windows[k - 1].frames.length * windows[k - 1].frameDur : null;
    const from = k > 0 ? (win.start + prevEnd) / 2 : -Infinity;
    const to = k < windows.length - 1 ? (windows[k + 1].start + end) / 2 : Infinity;
    for (let i = 0; i < win.frames.length; i++) {
      const t0 = win.start + i * win.frameDur;
      if (t0 + win.frameDur <= from || t0 >= to) continue;
      const id = maps[k].get(win.frames[i]) || 0;
      const s = Math.max(t0, from), e = Math.min(t0 + win.frameDur, to);
      const last = segs[segs.length - 1];
      if (last && last.id === id && Math.abs(last.end - s) < 1e-6) last.end = e;
      else segs.push({ id, start: s, end: e });
    }
  });
  return segs.filter((x) => x.id);
}

/**
 * Times inside each window where the segmentation model switches directly
 * from one speaker to another (no silence between): likely turn changes.
 */
export function changePoints(windows) {
  const out = [];
  for (const w of windows || []) {
    let prev = 0;
    for (let i = 0; i < w.frames.length; i++) {
      const f = w.frames[i];
      if (f && prev && f !== prev) out.push(w.start + i * w.frameDur);
      if (f) prev = f;
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Cut speech into short units for voice fingerprints: a new unit starts at a
 * pause, at a sentence end, at a likely turn change, or when a unit reaches
 * `maxLen` seconds. (Speakers usually change at sentence ends.)
 * Returns [{ start, end, wordIdx: [...] }].
 */
export function speechUnits(words, cuts = [], { pause = 0.3, maxLen = 3 } = {}) {
  const units = [];
  let cur = null, ci = 0;
  words.forEach((w, i) => {
    while (ci < cuts.length && cuts[ci] <= w.start) ci++;
    const crossed = cur && ci > 0 && cuts[ci - 1] > cur.end - 0.05 && cuts[ci - 1] <= w.start + 0.05;
    const prev = words[i - 1];
    const sentenceEnd = prev && /[.?!…]["')\]]?$/.test(prev.text);
    if (!cur || w.start - cur.end > pause || crossed || sentenceEnd || w.end - cur.start > maxLen) {
      cur = { start: w.start, end: w.end, wordIdx: [] };
      units.push(cur);
    }
    cur.wordIdx.push(i);
    cur.end = Math.max(cur.end, w.end);
  });
  return units;
}

const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
};

/**
 * Group voice fingerprints by speaker: average-linkage agglomerative
 * clustering on cosine similarity, merging while the closest pair of groups is
 * more similar than `threshold`. `vectors` may contain nulls (too short to
 * fingerprint); those get the label of the nearest unit in time.
 * Returns one label (0..k-1, in order of first appearance) per unit.
 */
export function clusterVoices(vectors, { threshold = 0.5, maxSpeakers = 8, exactly = null } = {}) {
  const idx = vectors.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return vectors.map(() => 0);
  let groups = idx.map((i) => [i]);
  const sim = new Map();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pair = (a, b) => { const k = key(a, b); if (!sim.has(k)) sim.set(k, cosine(vectors[a], vectors[b])); return sim.get(k); };
  const link = (g, h) => { let s = 0; for (const a of g) for (const b of h) s += pair(a, b); return s / (g.length * h.length); };
  while (groups.length > 1) {
    let best = -Infinity, bi = 0, bj = 1;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const s = link(groups[i], groups[j]);
      if (s > best) { best = s; bi = i; bj = j; }
    }
    if (exactly ? groups.length <= exactly : best < threshold && groups.length <= maxSpeakers) break;
    groups[bi] = groups[bi].concat(groups[bj]);
    groups.splice(bj, 1);
  }
  const label = new Array(vectors.length).fill(-1);
  groups.sort((g, h) => Math.min(...g) - Math.min(...h)).forEach((g, k) => g.forEach((i) => (label[i] = k)));
  for (let i = 0; i < label.length; i++) {
    if (label[i] >= 0) continue;
    let d = 1;
    while (label[i] < 0 && d < label.length) {
      if (i - d >= 0 && label[i - d] >= 0) label[i] = label[i - d];
      else if (i + d < label.length && label[i + d] >= 0) label[i] = label[i + d];
      d++;
    }
    if (label[i] < 0) label[i] = 0;
  }
  return label;
}

/**
 * Who is speaking. Tuned on real recordings (an interview, a film scene,
 * studio speech, solo speeches in two languages):
 * - If the creator said how many people speak, make exactly that many groups.
 *   (Interview 91% of words right, fast film argument 74%.)
 * - Otherwise group fingerprints with a cautious threshold, then fold any
 *   "speaker" made of a single fingerprint into the closest real voice, so a
 *   noisy moment in a solo video doesn't become a second person.
 */
export function groupVoices(vectors, { speakers = null, threshold = 0.4, minUnits = 2 } = {}) {
  if (!vectors.some(Boolean) || speakers === 1) return vectors.map(() => 0);
  if (speakers) return clusterVoices(vectors, { exactly: speakers });
  const L = clusterVoices(vectors, { threshold });
  for (;;) {
    const groups = new Map();
    L.forEach((l, i) => { if (vectors[i]) { if (!groups.has(l)) groups.set(l, []); groups.get(l).push(i); } });
    if (groups.size < 2) break;
    const small = [...groups.entries()].filter(([, g]) => g.length < minUnits).sort((x, y) => x[1].length - y[1].length)[0];
    if (!small) break;
    const [sl, sg] = small;
    let best = -Infinity, to = null;
    for (const [l, g] of groups) {
      if (l === sl) continue;
      let sum = 0;
      for (const x of sg) for (const y of g) sum += cosine(vectors[x], vectors[y]);
      sum /= sg.length * g.length;
      if (sum > best) { best = sum; to = l; }
    }
    L.forEach((l, i) => { if (l === sl) L[i] = to; });
  }
  const order = [];
  L.forEach((l) => { if (!order.includes(l)) order.push(l); });
  return L.map((l) => order.indexOf(l));
}

/** Units + labels -> speaker segments for assignSpeakers({ powerset: false }). */
export function unitsToSegments(units, labels) {
  return units.map((u, i) => ({ id: labels[i] + 1, start: u.start, end: u.end }));
}

/** Keep `cast` in step with the speakers words actually use. Existing names and colors are kept. */
export function syncCast(words, cast = []) {
  const used = [];
  for (const w of words) if (!used.includes(w.speaker)) used.push(w.speaker);
  const byId = new Map(cast.map((c) => [c.id, c]));
  const taken = new Set(cast.map((c) => c.color.toLowerCase()));
  const next = () => SPEAKER_COLORS.find((c) => !taken.has(c.toLowerCase())) || SPEAKER_COLORS[taken.size % SPEAKER_COLORS.length];
  return used.map((id, i) => {
    if (byId.has(id)) return byId.get(id);
    const color = next();
    taken.add(color.toLowerCase());
    const named = words.find((w) => w.speaker === id && w.speakerName)?.speakerName;
    return { id, name: named || `Speaker ${Number(id.slice(1)) || i + 1}`, color };
  });
}

// ---------------------------------------------------------------- intonation

/** Speaker's voice profile in OpenCaptions' shape (baseline = median). */
export function voiceProfile(words) {
  const hz = words.map((w) => w.f?.hz).filter((h) => h > 0);
  const db = words.map((w) => w.f?.db).filter((d) => d > -60);
  return {
    pitch_baseline_hz: r2(median(hz) || 150),
    pitch_p10: r2(pct(hz, 10) || 100),
    pitch_p90: r2(pct(hz, 90) || 200),
    volume_baseline_db: r2(median(db) || -20),
    volume_p10: r2(pct(db, 10) || -30),
    volume_p90: r2(pct(db, 90) || -10),
  };
}

const FUNCTION_WORDS = new Set(
  ('a an the and or but so to of in on at for with by from as is are was were be been am i you he she it we ' +
    'they me him her us them my your his its our their this that do does did have has had just um uh like ' +
    'na ya wa kwa ni si')
    .split(' '),
);

/**
 * Map each word's pitch and volume to CWI weight, size and emphasis.
 * `sensitivity` scales how far from neutral the styling goes (1 = default).
 * Words the creator adjusted keep their manual values.
 */
export function mapIntonation(words, cast, { sensitivity = 1 } = {}) {
  for (const sp of cast) {
    const ws = words.filter((w) => w.speaker === sp.id);
    const measured = ws.filter((w) => w.f);
    if (!measured.length) continue;
    const vp = voiceProfile(measured);
    sp.voice_profile = vp;
    const pMid = semis(vp.pitch_baseline_hz);
    const pRange = Math.max(semis(vp.pitch_p90) - semis(vp.pitch_p10), 3); // semitones
    const vRange = Math.max(vp.volume_p90 - vp.volume_p10, 6); // dB
    const dbs = measured.map((w) => w.f.db).filter((d) => d > -60);
    const vMad = Math.max(median(dbs.map((d) => Math.abs(d - vp.volume_baseline_db))) * 1.4826, 2.5);

    for (const w of measured) {
      const { db, hz } = w.f;
      // ≈ -0.5 at the speaker's p10, +0.5 at p90. A small dead zone keeps
      // ordinary word-to-word wobble from flickering the type.
      const dead = (x, d) => Math.sign(x) * Math.max(0, Math.abs(x) - d);
      const pn = hz > 0 ? dead((semis(hz) - pMid) / pRange, 0.1) : 0;
      const vn = db > -60 ? dead((db - vp.volume_baseline_db) / vRange, 0.05) : -0.6;
      // Low pitch -> bold, high pitch -> thin (CWI intonation guide).
      const weight = clamp(round(CWI.WEIGHT_DEFAULT - pn * 600 * sensitivity, 50), CWI.WEIGHT_MIN, CWI.WEIGHT_MAX);
      const size = clamp(r2(1 + vn * 0.6 * sensitivity), CWI.SIZE_MIN, CWI.SIZE_MAX);
      // Emphasis: clearly louder than this speaker usually is, or marked with "!".
      const zL = db > -60 ? (db - vp.volume_baseline_db) / vMad : -2;
      let score = (0.75 * zL + 0.3 * Math.max(0, pn * 2)) * sensitivity + (/!/.test(w.text) ? 0.8 : 0);
      if (FUNCTION_WORDS.has(bare(w.text))) score -= 0.9;
      const emphasis = score >= 1.5;
      w.auto = { weight, size, emphasis };
    }
  }
  for (const w of words) {
    w.weight = w.manual.weight ?? w.auto.weight;
    w.size = w.manual.size ?? w.auto.size;
    w.emphasis = w.manual.emphasis ?? w.auto.emphasis;
  }
  return words;
}

// ---------------------------------------------------------------- captions

export const LAYOUTS = {
  short: { maxWords: 4, maxChars: 24, pauseBreak: 0.5 },
  long: { maxWords: 12, maxChars: CWI.MAX_CHARS_PER_LINE, pauseBreak: 0.8 },
};

/** Group words into caption events: one speaker each, never overlapping. */
export function groupCaptions(words, layout = LAYOUTS.short) {
  const out = [];
  let cur = null;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const chars = cur ? cur.chars + 1 + w.text.length : w.text.length;
    const brk =
      !cur ||
      w.speaker !== cur.speaker ||
      cur.wordIds.length >= layout.maxWords ||
      chars > layout.maxChars ||
      (prev && w.start - prev.end > layout.pauseBreak) ||
      (prev && /[.?!…]["')\]]?$/.test(prev.text)) ||
      (prev && /[,;:]$/.test(prev.text) && cur.wordIds.length >= Math.ceil(layout.maxWords / 2));
    if (brk) {
      if (cur) out.push(cur);
      cur = { id: uid('c'), speaker: w.speaker, wordIds: [], chars: 0, start: w.start, end: w.end };
    }
    cur.wordIds.push(w.id);
    cur.chars = cur.wordIds.length === 1 ? w.text.length : chars;
    cur.end = w.end;
  });
  if (cur) out.push(cur);
  out.forEach((c, i) => {
    const next = out[i + 1];
    c.end = Math.min(next ? next.start : Infinity, c.end + 0.6);
  });
  return out;
}

/** Full pass. Call again after any edit; manual choices survive. */
export function analyze(project, { layout = 'short', sensitivity = 1 } = {}) {
  project.cast = syncCast(project.words, project.cast);
  mapIntonation(project.words, project.cast, { sensitivity });
  project.captions = groupCaptions(project.words, LAYOUTS[layout] || LAYOUTS.short);
  return project;
}

// ---------------------------------------------------------------- .cwi.json

export function toCWIDocument(project, meta = {}) {
  const byId = new Map(project.words.map((w) => [w.id, w]));
  const captions = project.captions.map((c, i) => {
    const words = c.wordIds.map((id) => byId.get(id)).filter(Boolean);
    return {
      id: `C${i + 1}`,
      start: r3(c.start),
      end: r3(c.end),
      speaker_id: c.speaker,
      words: words.map((w) => ({ text: w.text, start: r3(w.start), end: r3(w.end), weight: w.weight, size: w.size, emphasis: !!w.emphasis })),
      layout_hint: { estimated_lines: c.chars > CWI.MAX_CHARS_PER_LINE ? 2 : 1, max_line_width_chars: Math.min(c.chars, CWI.MAX_CHARS_PER_LINE) },
    };
  });
  return {
    $schema: CWI.SCHEMA,
    version: CWI.VERSION,
    metadata: {
      ...(meta.title ? { title: meta.title } : {}),
      duration: r3(meta.duration ?? project.words.at(-1)?.end ?? 0),
      language: meta.language || 'und',
      created_at: new Date().toISOString(),
      generator: 'reactive-captions/0.2.0',
      extractor_backend: meta.backend || 'browser-whisper+wespeaker',
    },
    cast: project.cast.map((s) => ({ id: s.id, name: s.name, color: s.color, voice_profile: s.voice_profile || voiceProfile([]) })),
    captions,
  };
}
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Load a .cwi.json (from this tool or OpenCaptions). Its styling is kept as-is. */
export function fromCWIDocument(doc) {
  if (!doc || !Array.isArray(doc.captions) || !Array.isArray(doc.cast)) throw new Error('That file is not a CWI document.');
  const words = [];
  for (const c of [...doc.captions].sort((a, b) => a.start - b.start)) {
    for (const cw of c.words || []) {
      const w = makeWord(cw.text, cw.start, cw.end);
      w.speaker = c.speaker_id;
      w.weight = cw.weight ?? CWI.WEIGHT_DEFAULT;
      w.size = cw.size ?? 1;
      w.emphasis = !!cw.emphasis;
      w.auto = { weight: w.weight, size: w.size, emphasis: w.emphasis };
      words.push(w);
    }
  }
  const cast = doc.cast.map((s) => ({ id: s.id, name: s.name || s.id, color: s.color, voice_profile: s.voice_profile }));
  return { words, cast, captions: [], language: doc.metadata?.language };
}
