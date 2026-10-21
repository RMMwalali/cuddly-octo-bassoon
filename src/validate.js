// CWI validation: the 12 rules and scoring from OpenCaptions' @opencaptions/spec
// (MIT, github.com/broomva/opencaptions), ported to plain JS so the check runs
// in the browser. Scores: 100 - 15 per error - 5 per warning; a pillar passes at 80.

import { CWI } from './cwi.js';

const BACKGROUND = '#1a1a1a';

function luminance(hex) {
  const h = hex.replace('#', '');
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrastRatio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const f = (rule_id, severity, message, location, suggestion) => ({ rule_id, severity, message, location, suggestion });

const RULES = [
  ['ATT_001', 'attribution', 'Every caption has a speaker', (d) => {
    const ids = new Set(d.cast.map((s) => s.id));
    return d.captions.filter((c) => !c.speaker_id || !ids.has(c.speaker_id))
      .map((c) => f('ATT_001', 'error', `Caption ${c.id} has no known speaker`, { caption_id: c.id }, 'Pick a speaker for this caption'));
  }],
  ['ATT_002', 'attribution', 'Each speaker has a unique color', (d) => {
    const seen = new Map(), out = [];
    for (const s of d.cast) {
      const k = s.color.toLowerCase();
      if (seen.has(k)) out.push(f('ATT_002', 'error', `${s.name} and ${seen.get(k)} share the color ${s.color}`, undefined, 'Give each speaker their own color'));
      else seen.set(k, s.name);
    }
    return out;
  }],
  ['ATT_003', 'attribution', 'Speaker colors are readable (4.5:1 contrast)', (d) => d.cast
    .map((s) => [s, contrastRatio(s.color, BACKGROUND)])
    .filter(([, r]) => r < 4.5)
    .map(([s, r]) => f('ATT_003', 'error', `${s.name}'s color ${s.color} has ${r.toFixed(2)}:1 contrast (needs 4.5:1)`, undefined, 'Choose a lighter color'))],
  ['SYN_001', 'synchronization', 'Every word has a valid time', (d) => d.captions.flatMap((c) => c.words
    .map((w, i) => [w, i]).filter(([w]) => w.start < 0 || w.end <= 0 || w.end <= w.start)
    .map(([w, i]) => f('SYN_001', 'error', `"${w.text}" has an invalid time`, { caption_id: c.id, word_index: i })))],
  ['SYN_002', 'synchronization', 'Word times run in order', (d) => d.captions.flatMap((c) => c.words.slice(1)
    .map((w, i) => [w, c.words[i], i + 1]).filter(([w, p]) => w.start < p.start || w.end < p.end)
    .map(([w, , i]) => f('SYN_002', 'error', `"${w.text}" starts before the word before it`, { caption_id: c.id, word_index: i })))],
  ['SYN_003', 'synchronization', 'Captions never overlap', (d) => {
    const s = [...d.captions].sort((a, b) => a.start - b.start);
    return s.slice(1).filter((c, i) => c.start < s[i].end - 1e-6)
      .map((c) => f('SYN_003', 'error', `Caption ${c.id} overlaps the one before it`, { caption_id: c.id }));
  }],
  ['SYN_004', 'synchronization', `Word animations last ${CWI.ANIMATION_MS} ms`, (d) => d.captions.flatMap((c) => c.words
    .map((w, i) => [w, i]).filter(([w]) => w.animation?.duration_ms !== undefined && w.animation.duration_ms !== CWI.ANIMATION_MS)
    .map(([w, i]) => f('SYN_004', 'warning', `"${w.text}" animates for ${w.animation.duration_ms} ms`, { caption_id: c.id, word_index: i })))],
  ['INT_001', 'intonation', 'Weights are within 100–900', (d) => d.captions.flatMap((c) => c.words
    .map((w, i) => [w, i]).filter(([w]) => w.weight < CWI.WEIGHT_MIN || w.weight > CWI.WEIGHT_MAX)
    .map(([w, i]) => f('INT_001', 'error', `"${w.text}" has weight ${w.weight}`, { caption_id: c.id, word_index: i })))],
  ['INT_002', 'intonation', 'Sizes are within 0.7–1.5', (d) => d.captions.flatMap((c) => c.words
    .map((w, i) => [w, i]).filter(([w]) => w.size < CWI.SIZE_MIN || w.size > CWI.SIZE_MAX)
    .map(([w, i]) => f('INT_002', 'error', `"${w.text}" has size ${w.size}`, { caption_id: c.id, word_index: i })))],
  ['INT_003', 'intonation', 'At least 20% of words vary in weight', (d) => {
    const all = d.captions.flatMap((c) => c.words);
    const varied = all.filter((w) => w.weight !== CWI.WEIGHT_DEFAULT).length;
    const p = all.length ? (varied / all.length) * 100 : 100;
    return p < 20 ? [f('INT_003', 'warning', `Only ${p.toFixed(0)}% of words vary in weight`, undefined, 'Raise sensitivity, or check that the audio has clear speech')] : [];
  }],
  ['FCC_001', 'synchronization', 'No caption gaps over 3 s during speech', (d) => {
    const s = [...d.captions].sort((a, b) => a.start - b.start);
    return s.slice(1).map((c, i) => [c, c.start - s[i].end]).filter(([, g]) => g > CWI.MAX_GAP_S)
      .map(([c, g]) => f('FCC_001', 'warning', `${g.toFixed(1)} s with no caption before ${c.id}`, { caption_id: c.id }, 'Check for missed speech here'));
  }],
  ['FCC_002', 'synchronization', 'Captions fit in 42 characters', (d) => d.captions
    .map((c) => [c, c.words.reduce((n, w, i) => n + w.text.length + (i ? 1 : 0), 0)])
    .filter(([, n]) => n > CWI.MAX_CHARS_PER_LINE)
    .map(([c, n]) => f('FCC_002', 'warning', `Caption ${c.id} is ${n} characters`, { caption_id: c.id }, 'Use "Few words" or split the caption'))],
];

export const RULE_LIST = RULES.map(([id, pillar, label]) => ({ id, pillar, label }));

function pillarScore(findings) {
  const e = findings.filter((x) => x.severity === 'error').length;
  const w = findings.filter((x) => x.severity === 'warning').length;
  const score = Math.max(0, Math.min(100, 100 - (e * 15 + w * 5)));
  return { score, passed: score >= 80, findings };
}

/** Validate a CWI document (see toCWIDocument). */
export function validate(doc) {
  const by = { attribution: [], synchronization: [], intonation: [] };
  const perRule = {};
  for (const [id, pillar, , fn] of RULES) {
    const found = fn(doc);
    perRule[id] = found;
    by[pillar].push(...found);
  }
  const pillars = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, pillarScore(v)]));
  return {
    passed: Object.values(pillars).every((p) => p.passed),
    overall_score: Math.round((pillars.attribution.score + pillars.synchronization.score + pillars.intonation.score) / 3),
    pillars,
    rules: perRule,
    stats: {
      caption_events: doc.captions.length,
      words_total: doc.captions.reduce((n, c) => n + c.words.length, 0),
      speakers_detected: doc.cast.length,
    },
  };
}
