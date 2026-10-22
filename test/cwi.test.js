import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spanLoudnessDb, spanPitchHz, wordFeatures } from '../src/audio.js';
import {
  wordsFromWhisper, parseCues, wordsFromCues, assignSpeakers, analyze, groupCaptions, LAYOUTS,
  toCWIDocument, fromCWIDocument, SPEAKER_COLORS, CWI,
} from '../src/cwi.js';
import { validate, contrastRatio } from '../src/validate.js';

const SR = 16000;

function synth(spec) {
  const s = new Float32Array(Math.ceil((spec.at(-1).end + 0.5) * SR));
  for (const w of spec) {
    for (let i = Math.floor(w.start * SR); i < w.end * SR; i++) {
      const t = i / SR;
      s[i] = w.amp * (Math.sin(2 * Math.PI * w.hz * t) + 0.3 * Math.sin(4 * Math.PI * w.hz * t));
    }
  }
  return s;
}

/** Two speakers: a low voice (~120 Hz) and a high voice (~220 Hz), each with their own ups and downs. */
function dialogue() {
  const lines = [
    ['A', 'where were you last night', [120, 118, 122, 119, 150], [0.1, 0.1, 0.1, 0.1, 0.1]],
    ['B', 'i was at home i swear', [220, 225, 218, 222, 260, 200], [0.1, 0.1, 0.1, 0.1, 0.1, 0.1]],
    ['A', 'that is a LIE', [120, 118, 121, 95], [0.1, 0.1, 0.1, 0.6]],
    ['B', 'please just listen', [222, 220, 219], [0.02, 0.02, 0.02]],
  ];
  const spec = [];
  const segments = [];
  let t = 0.2;
  for (const [who, text, hz, amp] of lines) {
    const start = t;
    text.split(' ').forEach((word, i) => {
      spec.push({ who, text: word, start: t, end: t + 0.3, hz: hz[i], amp: amp[i] });
      t += 0.38;
    });
    segments.push({ id: who === 'A' ? 2 : 1, start, end: t - 0.05 });
    t += 0.4;
  }
  return { spec, segments, samples: synth(spec) };
}

function project() {
  const { spec, segments, samples } = dialogue();
  const words = wordsFromWhisper(spec.map((s) => ({ text: ' ' + s.text, timestamp: [s.start, s.end] })));
  assignSpeakers(words, segments);
  wordFeatures(words, samples, SR).forEach((f, i) => (words[i].f = f));
  return { spec, p: analyze({ words, cast: [] }) };
}

test('audio features track loudness and pitch', () => {
  const s = synth([{ start: 0, end: 0.5, amp: 0.05, hz: 140 }, { start: 0.6, end: 1.1, amp: 0.5, hz: 220 }]);
  assert.ok(spanLoudnessDb(s, SR, 0.6, 1.1) - spanLoudnessDb(s, SR, 0, 0.5) > 18);
  assert.ok(Math.abs(spanPitchHz(s, SR, 0, 0.5) - 140) < 4);
  assert.ok(Math.abs(spanPitchHz(s, SR, 0.6, 1.1) - 220) < 6);
});

test('speakers are attributed, numbered in order and colored from the palette', () => {
  const { p, spec } = project();
  assert.deepEqual(p.words.map((w) => w.speaker), spec.map((s) => (s.who === 'A' ? 'S1' : 'S2')));
  assert.deepEqual(p.cast.map((c) => [c.id, c.color]), [['S1', SPEAKER_COLORS[0]], ['S2', SPEAKER_COLORS[1]]]);
  // Captions never mix speakers.
  const byId = new Map(p.words.map((w) => [w.id, w]));
  for (const c of p.captions) assert.ok(c.wordIds.every((id) => byId.get(id).speaker === c.speaker));
});

test('overlap classes and stray detections fold into real speakers', () => {
  const words = wordsFromWhisper('a b c d e f g h i j'.split(' ').map((t, i) => ({ text: t, timestamp: [i, i + 0.8] })));
  assignSpeakers(words, [
    { id: 1, start: 0, end: 4.9 },
    { id: 4, start: 4.9, end: 6 }, // overlap {1,2} -> speaker 1
    { id: 3, start: 6, end: 6.9 }, // one stray word
    { id: 2, start: 7, end: 10 },
  ]);
  assert.deepEqual(words.map((w) => w.speaker).join(''), 'S1S1S1S1S1S1S1S2S2S2'.match(/S\d/g).join(''));
});

test('intonation follows CWI: low pitch bold, high pitch thin, loud big, quiet small', () => {
  const { p } = project();
  const w = (t) => p.words.find((x) => x.text === t);
  // Speaker A's "LIE" is far below A's own pitch and far louder.
  assert.ok(w('LIE').weight >= 700, `LIE weight ${w('LIE').weight}`);
  assert.ok(w('LIE').size >= 1.3, `LIE size ${w('LIE').size}`);
  assert.equal(w('LIE').emphasis, true);
  // Speaker A's "night" rises above A's usual pitch -> thinner than normal.
  assert.ok(w('night').weight < CWI.WEIGHT_DEFAULT, `night weight ${w('night').weight}`);
  // Speaker B's whispered "listen" is small.
  assert.ok(w('listen').size <= 0.8, `listen size ${w('listen').size}`);
  // Relative to each speaker: B's ordinary words are not thin just because B's voice is high.
  assert.ok(Math.abs(w('home').weight - CWI.WEIGHT_DEFAULT) <= 100, `home weight ${w('home').weight}`);
  for (const x of p.words) {
    assert.ok(x.weight >= 100 && x.weight <= 900 && x.weight % 50 === 0);
    assert.ok(x.size >= 0.7 && x.size <= 1.5);
  }
});

test('manual changes survive re-analysis', () => {
  const { p } = project();
  const w = p.words[0];
  w.manual.weight = 900;
  w.manual.emphasis = true;
  analyze(p, { sensitivity: 0.5 });
  assert.equal(w.weight, 900);
  assert.equal(w.emphasis, true);
});

test('long layout keeps captions within 42 characters and never overlapping', () => {
  const words = wordsFromWhisper(Array.from({ length: 40 }, (_, i) => ({ text: 'wordy' + i, timestamp: [i * 0.3, i * 0.3 + 0.25] })));
  const caps = groupCaptions(words, LAYOUTS.long);
  for (const c of caps) assert.ok(c.chars <= 42);
  for (let i = 1; i < caps.length; i++) assert.ok(caps[i].start >= caps[i - 1].end);
});

test('subtitle import keeps speaker names from VTT voice tags and NAME: prefixes', () => {
  const cues = parseCues('WEBVTT\n\n00:01.000 --> 00:02.000\n<v Amina>Habari yako\n\n00:02.500 --> 00:03.000\nJOE: Poa sana');
  assert.deepEqual(cues.map((c) => c.speaker), ['Amina', 'JOE']);
  const words = wordsFromCues(cues);
  const p = analyze({ words, cast: [] });
  assert.deepEqual(p.cast.map((c) => c.name), ['Amina', 'JOE']);
  assert.equal(words[2].text, 'Poa');
});

test('.cwi.json round-trips and passes the CWI check', () => {
  const { p } = project();
  const doc = toCWIDocument(p, { duration: 12, language: 'en', title: 'Test' });
  assert.equal(doc.$schema, CWI.SCHEMA);
  assert.equal(doc.cast.length, 2);
  assert.ok(doc.cast[0].voice_profile.pitch_baseline_hz < doc.cast[1].voice_profile.pitch_baseline_hz);
  const report = validate(doc);
  assert.equal(report.passed, true, JSON.stringify(report.pillars, null, 1));
  const back = fromCWIDocument(JSON.parse(JSON.stringify(doc)));
  assert.equal(back.words.length, p.words.length);
  assert.deepEqual(back.words.map((w) => w.weight), p.words.map((w) => w.weight));
});

test('validator agrees with OpenCaptions fixtures', () => {
  const dir = new URL('./fixtures/', import.meta.url);
  for (const name of readdirSync(new URL('valid/', dir))) {
    const r = validate(JSON.parse(readFileSync(new URL(`valid/${name}`, dir))));
    assert.equal(r.passed, true, `${name}: ${JSON.stringify(r.pillars)}`);
  }
  const expect = { 'missing-speaker.cwi.json': 'ATT_001', 'overlapping-events.cwi.json': 'SYN_003', 'flat-intonation.cwi.json': 'INT_003' };
  for (const [name, rule] of Object.entries(expect)) {
    const r = validate(JSON.parse(readFileSync(new URL(`invalid/${name}`, dir))));
    assert.ok(r.rules[rule].length > 0, `${name} should trigger ${rule}`);
  }
  for (const c of SPEAKER_COLORS) assert.ok(contrastRatio(c, '#1a1a1a') >= 4.5, c);
});

test('exports carry speakers and CWI styling', async () => {
  const { toSRT, toVTT, toASS, toCWIJSON, formatTime } = await import('../src/export.js');
  const { p } = project();
  p.cast[0].name = 'Amina';
  p.cast[1].name = 'Joe';
  const srt = toSRT(p);
  assert.match(srt, /^1\n00:00:00,200 --> /);
  assert.match(srt, /Amina: where were you/);
  assert.match(srt, /Joe: i was at home/);
  const vtt = toVTT(p);
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /<v Amina>where <00:00:00\.580>were/);
  assert.match(vtt, /<b>LIE<\/b>/);
  const ass = toASS(p, { width: 720, height: 1280 });
  assert.match(ass, /Style: CWI,Roboto Flex,/);
  // White, then the speaker's color (#6B8AFF -> &HFF8A6B&) over 600 ms from the word's start.
  assert.match(ass, /\\1c&HFFFFFF&\\t\(0,600,\\1c&HFF8A6B&\)\}where/);
  assert.match(ass, /\\b\d{3}\\fs\d+/);
  assert.match(ass, /\\fscx115\\fscy115/); // emphasis bounce
  const doc = JSON.parse(toCWIJSON(p, { duration: 10, language: 'en' }));
  assert.equal(doc.cast[0].name, 'Amina');
  assert.equal(formatTime(3661.5, ','), '01:01:01,500');
});

test('fonts map CWI weights into each typeface and keep regular at regular', async () => {
  const { getFont, fontWeight, fauxBold, cssUrl, FONTS } = await import('../src/fonts.js');
  const rf = getFont('roboto-flex');
  assert.deepEqual([100, 400, 900].map((w) => fontWeight(rf, w)), [100, 400, 1000]);
  const oswald = getFont('oswald');
  assert.deepEqual([100, 400, 900].map((w) => fontWeight(oswald, w)), [200, 400, 700]);
  const bebas = getFont('bebas');
  assert.equal(fontWeight(bebas, 900), 400);
  assert.ok(fauxBold(bebas, 900, 100) > 0 && fauxBold(rf, 900, 100) === 0);
  assert.match(cssUrl([rf]), /family=Roboto\+Flex:opsz,wght@8\.\.144,100\.\.1000/);
  assert.equal(new Set(FONTS.map((f) => f.id)).size, FONTS.length);
  const { toASS } = await import('../src/export.js');
  const { p } = project();
  assert.match(toASS(p, { font: 'oswald' }), /Style: CWI,Oswald,[\s\S]*\\b700/);
});

test('windowed speaker labels are stitched into consistent speakers', async () => {
  const { stitchDiarization, POWERSET_TO_SPEAKER } = await import('../src/cwi.js');
  assert.deepEqual(POWERSET_TO_SPEAKER, [0, 1, 2, 3, 1, 1, 2]);
  // Truth: A for 0-12 s, B for 12-20 s. frameDur 0.5 s, windows of 10 s every 5 s.
  // The model's local labels flip between windows (A is "2" in window 2).
  const who = (t) => (t < 12 ? 'A' : 'B');
  const labels = [{ A: 1, B: 2 }, { A: 2, B: 1 }, { A: 3, B: 1 }];
  const windows = [0, 5, 10].map((start, k) => ({
    start, frameDur: 0.5,
    frames: Int8Array.from({ length: 20 }, (_, i) => labels[k][who(start + i * 0.5 + 0.25)]),
  }));
  const segs = stitchDiarization(windows);
  assert.deepEqual(segs.map((s) => [s.id, s.start, s.end]), [[1, -Infinity, 12], [2, 12, Infinity]].map(([id, a, b]) => [id, a === -Infinity ? segs[0].start : a, b === Infinity ? segs.at(-1).end : b]));
  assert.equal(segs.length, 2);
  assert.equal(segs[0].id, 1);
  assert.equal(segs[1].id, 2);
  assert.equal(segs[0].end, 12);
});

test('fbank matches kaldi-native-fbank', async () => {
  const { fbank } = await import('../src/fbank.js');
  const ref = JSON.parse(readFileSync(new URL('./fixtures/fbank-ref.json', import.meta.url)));
  const r = fbank(Float32Array.from(ref.samples), { cmn: false });
  assert.equal(r.frames, ref.fbank.length);
  let max = 0;
  ref.fbank.forEach((row, f) => row.forEach((v, b) => (max = Math.max(max, Math.abs(v - r.data[f * 80 + b])))));
  assert.ok(max < 0.01, `max diff ${max}`);
});

test('voices are grouped by fingerprint and units follow turns', async () => {
  const { speechUnits, clusterVoices, changePoints, unitsToSegments } = await import('../src/cwi.js');
  const words = wordsFromWhisper([
    ['hi', 0, 0.3], ['there', 0.35, 0.7], ['how', 0.75, 1.0], ['are', 1.05, 1.3], // A
    ['good', 1.35, 1.7], ['thanks', 1.75, 2.1], // B, no pause: needs a change point at 1.33
    ['great', 3.0, 3.4], // A after a pause
  ].map(([t, s, e]) => ({ text: t, timestamp: [s, e] })));
  const units = speechUnits(words, [1.33]);
  assert.deepEqual(units.map((u) => u.wordIdx.length), [4, 2, 1]);
  const A = [1, 0.1, 0], B = [0, 1, 0.2];
  assert.deepEqual(clusterVoices([A, B, [0.95, 0.15, 0.05]]), [0, 1, 0]);
  assert.deepEqual(clusterVoices([A, null, B]), [0, 0, 1]);
  assert.deepEqual(clusterVoices([A, [0.9, 0.2, 0.1], [1, 0, 0.1]]), [0, 0, 0]);
  assert.deepEqual(changePoints([{ start: 0, frameDur: 0.5, frames: Int8Array.from([0, 2, 2, 0, 2, 3, 3]) }]), [2.5]);
  const segs = unitsToSegments(units, [0, 1, 0]);
  assignSpeakers(words, segs, { powerset: false, minShare: 0, minWords: 1 });
  assert.deepEqual(words.map((w) => w.speaker), ['S1', 'S1', 'S1', 'S1', 'S2', 'S2', 'S1']);
});

test('word times are kept inside the clip', async () => {
  const { clampWords } = await import('../src/cwi.js');
  const words = wordsFromWhisper([{ text: 'ask', timestamp: [28.0, 28.4] }, { text: 'to', timestamp: [29.7, 41.7] }]);
  clampWords(words, 30.2);
  assert.ok(words[1].end <= 30.2 && words[1].end > words[1].start);
});
