// The reaction engine: turns timed words + acoustic features into
// emphasis levels, caption pages and a mood per page. Pure functions — no DOM.

let nextId = 1;
const uid = (p) => `${p}${nextId++}`;

// ---------------------------------------------------------------- words in

/** Whisper `return_timestamps: 'word'` chunks -> clean, monotonic words. */
export function wordsFromWhisper(chunks) {
  const out = [];
  for (const c of chunks || []) {
    const text = (c.text || '').trim();
    if (!text) continue;
    let [start, end] = c.timestamp || [];
    start = Number.isFinite(start) ? start : out.length ? out[out.length - 1].end : 0;
    end = Number.isFinite(end) ? end : start + 0.4;
    // Punctuation-only tokens belong to the word before them.
    if (/^[^\p{L}\p{N}]+$/u.test(text) && out.length) {
      out[out.length - 1].text += text;
      out[out.length - 1].end = Math.max(out[out.length - 1].end, end);
      continue;
    }
    out.push({ text, start, end });
  }
  return finishWords(out);
}

/** Parse an SRT or WebVTT file into cues. */
export function parseCues(src) {
  const cues = [];
  const blocks = src.replace(/\r/g, '').split(/\n{2,}/);
  const ts = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/g;
  const toSec = (m) => {
    const parts = m.split(/[:.,]/).map(Number);
    const ms = parts.pop() / 10 ** (m.split(/[.,]/).pop().length);
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
    const text = lines
      .slice(i + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .trim();
    if (text) cues.push({ start: toSec(times[0]), end: toSec(times[1]), text });
  }
  return cues;
}

/**
 * Existing subtitles -> words. Cue time is shared out by word length, so the
 * engine can still react to the audio under each word.
 */
export function wordsFromCues(cues) {
  const out = [];
  for (const cue of cues) {
    const parts = cue.text.split(/\s+/).filter(Boolean);
    const weights = parts.map((p) => p.length + 2);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = cue.start;
    parts.forEach((p, i) => {
      const d = ((cue.end - cue.start) * weights[i]) / total;
      out.push({ text: p, start: t, end: t + d });
      t += d;
    });
  }
  return finishWords(out);
}

function finishWords(list) {
  let last = 0;
  return list.map((w) => {
    const start = Math.max(w.start, last);
    const end = Math.max(w.end, start + 0.05);
    last = start;
    return { id: uid('w'), text: w.text, start, end, level: 0, auto: { level: 0, score: 0 }, manual: false };
  });
}

// ---------------------------------------------------------------- emphasis

const FUNCTION_WORDS = new Set(
  ('a an the and or but so to of in on at for with by from as is are was were be been am i you he she it we ' +
    'they me him her us them my your his its our their this that these those do does did have has had ' +
    'just um uh like na ya wa kwa ni si')
    .split(' '),
);

const bare = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

function robustStats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { median: 0, spread: 1 };
  const median = v[Math.floor(v.length / 2)];
  const dev = v.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const mad = dev[Math.floor(dev.length / 2)] * 1.4826;
  return { median, spread: mad };
}

/**
 * Score every word for emphasis from loudness, pitch, stretch and punctuation.
 * Writes `auto` and (unless the creator overrode it) `level` on each word.
 * Levels: 0 normal · 1 stressed · 2 strong · 3 shout.
 */
export function scoreEmphasis(words, features, opts = {}) {
  const sensitivity = opts.sensitivity ?? 1; // 0.5 calm … 1.5 very reactive
  const speech = features.map((f) => f.db).filter((d) => d > -60);
  const L = robustStats(speech);
  const lSpread = Math.max(L.spread, 2.5); // dB; flat audio should not invent shouts
  const voiced = features.map((f) => (f.hz > 0 ? 12 * Math.log2(f.hz) : NaN));
  const P = robustStats(voiced);
  const pSpread = Math.max(P.spread, 1.5); // semitones

  const stretch = words.map((w) => (w.end - w.start) / (0.06 * Math.max(2, bare(w.text).length) + 0.08));
  const S = robustStats(stretch);

  words.forEach((w, i) => {
    const f = features[i] || { db: -100, hz: 0 };
    const zL = f.db > -60 ? (f.db - L.median) / lSpread : -2;
    const zP = f.hz > 0 ? (12 * Math.log2(f.hz) - P.median) / pSpread : 0;
    const zS = (stretch[i] - S.median) / Math.max(S.spread, 0.25);
    let score = 0.75 * zL + 0.35 * Math.max(0, zP) + 0.15 * Math.max(0, Math.min(zS, 3));
    if (/!/.test(w.text)) score += 0.8;
    if (w.text.length > 1 && w.text === w.text.toUpperCase() && /\p{L}/u.test(w.text)) score += 0.6;
    score *= sensitivity;

    let level = score >= 2.4 ? 3 : score >= 1.5 ? 2 : score >= 0.85 ? 1 : 0;
    if (FUNCTION_WORDS.has(bare(w.text)) && level < 3) level = Math.min(level, 1);

    w.zL = round(zL); w.zP = round(zP);
    w.auto = { level, score: round(score) };
    if (!w.manual) w.level = level;
  });
  return words;
}

// ---------------------------------------------------------------- pages

export const LAYOUTS = {
  short: { maxWords: 3, maxChars: 22, pauseBreak: 0.5 },
  long: { maxWords: 7, maxChars: 42, pauseBreak: 0.7 },
};

/** Group words into the chunks that appear on screen together. */
export function groupPages(words, layout = LAYOUTS.short) {
  const pages = [];
  let cur = null;
  const close = () => cur && cur.wordIds.length && pages.push(cur);
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const chars = cur ? cur.chars + 1 + w.text.length : w.text.length;
    const breakHere =
      !cur ||
      cur.wordIds.length >= layout.maxWords ||
      chars > layout.maxChars ||
      (prev && w.start - prev.end > layout.pauseBreak) ||
      (prev && /[.?!…]["')\]]?$/.test(prev.text)) ||
      (prev && /[,;:]$/.test(prev.text) && cur.wordIds.length >= Math.ceil(layout.maxWords / 2)) ||
      // A shout reads best on its own line in short-form layouts.
      (layout.maxWords <= 4 && (w.level === 3 || (prev && prev.level === 3)));
    if (breakHere) {
      close();
      cur = { id: uid('p'), wordIds: [], chars: 0, start: w.start, end: w.end, mood: 'neutral', moodAuto: 'neutral', moodManual: false };
    }
    cur.wordIds.push(w.id);
    cur.chars = cur.wordIds.length === 1 ? w.text.length : chars;
    cur.end = w.end;
  });
  close();
  // Keep each page up a little after its last word, but never over the next one.
  pages.forEach((p, i) => {
    const next = pages[i + 1];
    p.end = Math.min(next ? next.start : Infinity, p.end + 0.6);
  });
  return pages;
}

// ---------------------------------------------------------------- mood

const LEX = {
  excited: 'amazing awesome love wow yes yeah omg incredible insane crazy best unbelievable finally win won perfect beautiful epic fire hype lets let\'s go goal huge massive legendary poa safi bomba noma furaha hongera',
  angry: 'hate stupid worst angry annoying ridiculous terrible damn stop never disgusting furious nonsense trash ujinga hasira',
  sad: 'sorry sad miss missed lost cry crying hurt alone tired unfortunately pain broke broken goodbye grief huzuni pole nimechoka',
};
const LEXSETS = Object.fromEntries(Object.entries(LEX).map(([k, v]) => [k, new Set(v.split(' '))]));

export const MOODS = ['neutral', 'excited', 'angry', 'soft', 'question'];

/** Heuristic mood for one page from energy, pitch, pace, punctuation and words. */
export function pageMood(page, byId) {
  const ws = page.wordIds.map((id) => byId.get(id)).filter(Boolean);
  if (!ws.length) return 'neutral';
  const avg = (f) => ws.reduce((a, w) => a + (f(w) || 0), 0) / ws.length;
  const energy = avg((w) => w.zL);
  const pitch = avg((w) => w.zP);
  const text = ws.map((w) => w.text).join(' ');
  const tokens = ws.map((w) => bare(w.text));
  const hits = (k) => tokens.filter((t) => LEXSETS[k].has(t)).length;
  const shout = ws.some((w) => w.level === 3);

  if (/!/.test(text) || (energy > 0.6 && pitch > 0.4) || (hits('excited') && energy > 0) || (shout && pitch > 0)) return 'excited';
  if ((hits('angry') && energy > 0.3) || (shout && pitch <= 0)) return 'angry';
  if (/\?["')]?$/.test(text)) return 'question';
  if (energy < -0.8 || (hits('sad') && energy < 0.4)) return 'soft';
  return 'neutral';
}

export function assignMoods(pages, words) {
  const byId = new Map(words.map((w) => [w.id, w]));
  for (const p of pages) {
    p.moodAuto = pageMood(p, byId);
    if (!p.moodManual) p.mood = p.moodAuto;
  }
  return pages;
}

// ---------------------------------------------------------------- sounds

// AudioSet labels worth showing to a viewer, and how to write them.
export const SOUND_LABELS = {
  Laughter: 'laughs', 'Belly laugh': 'laughs', Giggle: 'giggles', Snicker: 'snickers', 'Chuckle, chortle': 'chuckles',
  'Baby laughter': 'baby laughs', Applause: 'applause', Clapping: 'clapping', Cheering: 'cheering', Crowd: 'crowd noise',
  Gasp: 'gasps', Sigh: 'sighs', Groan: 'groans', 'Crying, sobbing': 'crying', Screaming: 'screaming', Whoop: 'whoops',
  Whistling: 'whistling', Cough: 'coughs', Sneeze: 'sneezes', Music: 'music', Singing: 'singing',
  'Dog': 'dog barking', Bark: 'dog barking', Explosion: 'explosion', 'Door': 'door', Knock: 'knocking',
  'Telephone bell ringing': 'phone ringing', Ringtone: 'phone ringing', Thunder: 'thunder', Rain: 'rain',
};

/**
 * Windows of classifier output -> merged sound captions.
 * `windows`: [{ start, end, labels: [{ label, score }] }]
 */
export function soundsFromTags(windows, threshold = 0.2) {
  const raw = [];
  for (const win of windows) {
    for (const { label, score } of win.labels) {
      const text = SOUND_LABELS[label];
      if (!text) continue;
      const need = text === 'music' ? Math.max(threshold, 0.45) : threshold;
      if (score >= need) raw.push({ text, start: win.start, end: win.end, score });
    }
  }
  raw.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of raw) {
    const last = merged.findLast?.((m) => m.text === r.text) ?? [...merged].reverse().find((m) => m.text === r.text);
    if (last && r.start <= last.end + 0.25) {
      last.end = Math.max(last.end, r.end);
      last.score = Math.max(last.score, r.score);
    } else merged.push({ ...r });
  }
  // Long beds of music get one short label at the start, not a permanent tag.
  return merged.map((m) => ({
    id: uid('s'),
    text: m.text,
    start: m.start,
    end: m.text === 'music' ? Math.min(m.end, m.start + 2.5) : m.end,
    score: round(m.score),
  }));
}

// ---------------------------------------------------------------- whole pass

/** Run the full reaction pass. Re-run after edits; manual overrides are kept. */
export function react(project, features, opts = {}) {
  const layout = LAYOUTS[opts.layout || 'short'] || LAYOUTS.short;
  if (features) scoreEmphasis(project.words, features, opts);
  const oldMoods = new Map(
    (project.pages || []).filter((p) => p.moodManual).map((p) => [p.wordIds.join(','), p.mood]),
  );
  project.pages = groupPages(project.words, layout);
  for (const p of project.pages) {
    const m = oldMoods.get(p.wordIds.join(','));
    if (m) { p.mood = m; p.moodManual = true; }
  }
  assignMoods(project.pages, project.words);
  return project;
}

const round = (x) => Math.round(x * 100) / 100;
