import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spanLoudnessDb, spanPitchHz, wordFeatures } from '../src/audio.js';
import {
  wordsFromWhisper, parseCues, wordsFromCues, scoreEmphasis, groupPages, react, soundsFromTags, LAYOUTS,
} from '../src/reactive.js';
import { toSRT, toVTT, toASS, formatTime } from '../src/export.js';

const SR = 16000;

/** Synthetic "speech": one tone burst per word with its own loudness and pitch. */
function synth(spec) {
  const dur = spec.at(-1).end + 0.5;
  const s = new Float32Array(Math.ceil(dur * SR));
  for (const w of spec) {
    for (let i = Math.floor(w.start * SR); i < w.end * SR; i++) {
      const t = i / SR;
      s[i] = w.amp * (Math.sin(2 * Math.PI * w.hz * t) + 0.3 * Math.sin(4 * Math.PI * w.hz * t));
    }
  }
  return s;
}

test('loudness and pitch track the signal', () => {
  const s = synth([{ start: 0, end: 0.5, amp: 0.05, hz: 140 }, { start: 0.6, end: 1.1, amp: 0.5, hz: 220 }]);
  const quiet = spanLoudnessDb(s, SR, 0, 0.5);
  const loud = spanLoudnessDb(s, SR, 0.6, 1.1);
  assert.ok(loud - quiet > 18, `expected ~20 dB difference, got ${loud - quiet}`);
  assert.ok(Math.abs(spanPitchHz(s, SR, 0, 0.5) - 140) < 4);
  assert.ok(Math.abs(spanPitchHz(s, SR, 0.6, 1.1) - 220) < 6);
  assert.equal(spanPitchHz(new Float32Array(SR), SR, 0, 1), 0);
});

test('whisper chunks are cleaned and punctuation merges into the previous word', () => {
  const w = wordsFromWhisper([
    { text: ' Hello', timestamp: [0, 0.4] },
    { text: ' world', timestamp: [0.4, 0.9] },
    { text: '!', timestamp: [0.9, 1.0] },
    { text: ' ', timestamp: [1, 1.1] },
    { text: ' again', timestamp: [1.2, null] },
  ]);
  assert.deepEqual(w.map((x) => x.text), ['Hello', 'world!', 'again']);
  assert.equal(w[1].end, 1.0);
  assert.ok(w[2].end > w[2].start);
});

test('the loud, high word becomes a shout; the rest stay calm', () => {
  const spec = 'so today we are going to try something completely INSANE okay'.split(' ').map((text, i) => ({
    text, start: i * 0.4, end: i * 0.4 + 0.35, amp: text === 'INSANE' ? 0.7 : 0.08 + (i % 3) * 0.01, hz: text === 'INSANE' ? 260 : 150 + (i % 4) * 5,
  }));
  const samples = synth(spec);
  const words = wordsFromWhisper(spec.map((s) => ({ text: ' ' + s.text, timestamp: [s.start, s.end] })));
  scoreEmphasis(words, wordFeatures(words, samples, SR));
  const insane = words.find((w) => w.text === 'INSANE');
  assert.equal(insane.level, 3);
  const others = words.filter((w) => w !== insane);
  assert.ok(others.every((w) => w.level <= 1), others.map((w) => `${w.text}:${w.level}`).join(' '));
});

test('manual levels survive a re-run', () => {
  const words = wordsFromWhisper([{ text: 'a', timestamp: [0, 0.3] }, { text: 'b', timestamp: [0.3, 0.6] }]);
  words[0].level = 2; words[0].manual = true;
  scoreEmphasis(words, [{ db: -20, hz: 0 }, { db: -20, hz: 0 }]);
  assert.equal(words[0].level, 2);
});

test('flat audio does not invent emphasis', () => {
  const words = wordsFromWhisper('this is a very even and boring sentence'.split(' ').map((t, i) => ({ text: t, timestamp: [i * 0.3, i * 0.3 + 0.25] })));
  scoreEmphasis(words, words.map((_, i) => ({ db: -24 + (i % 2) * 0.5, hz: 150 })));
  assert.ok(words.every((w) => w.level === 0));
});

test('pages break on size, pauses and sentence ends', () => {
  const words = wordsFromWhisper([
    ['One', 0], ['two', 0.3], ['three', 0.6], ['four', 0.9], ['five.', 1.2], ['Six', 1.5], ['seven', 3.0],
  ].map(([t, s]) => ({ text: t, timestamp: [s, s + 0.25] })));
  const pages = groupPages(words, LAYOUTS.short);
  const text = pages.map((p) => p.wordIds.map((id) => words.find((w) => w.id === id).text).join(' '));
  assert.deepEqual(text, ['One two three', 'four five.', 'Six', 'seven']);
  for (let i = 0; i < pages.length - 1; i++) assert.ok(pages[i].end <= pages[i + 1].start);
});

test('moods come from energy, punctuation and words', () => {
  const words = wordsFromWhisper([
    { text: 'this', timestamp: [0, 0.3] }, { text: 'is', timestamp: [0.3, 0.5] }, { text: 'amazing!', timestamp: [0.5, 1] },
    { text: 'are', timestamp: [2, 2.2] }, { text: 'you', timestamp: [2.2, 2.4] }, { text: 'sure?', timestamp: [2.4, 2.8] },
    { text: 'i', timestamp: [4, 4.2] }, { text: 'miss', timestamp: [4.2, 4.6] }, { text: 'her', timestamp: [4.6, 5] },
  ]);
  const feats = words.map((w, i) => ({ db: i >= 6 ? -40 : -22, hz: 150 }));
  const p = react({ words }, feats).pages;
  assert.deepEqual(p.map((x) => x.mood), ['excited', 'question', 'soft']);
});

test('subtitle import spreads cue time over words', () => {
  const cues = parseCues(`1\n00:00:01,000 --> 00:00:03,000\nHello <i>big</i> world\n\n2\n00:00:04.500 --> 00:00:05.000\nBye`);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello big world');
  assert.equal(cues[1].start, 4.5);
  const words = wordsFromCues(cues);
  assert.equal(words.length, 4);
  assert.equal(words[0].start, 1);
  assert.ok(Math.abs(words[2].end - 3) < 1e-9);
  const vtt = parseCues('WEBVTT\n\n00:01.000 --> 00:02.000\nShort form');
  assert.equal(vtt[0].start, 1);
});

test('sound windows merge into captions', () => {
  const s = soundsFromTags([
    { start: 0, end: 2, labels: [{ label: 'Speech', score: 0.9 }, { label: 'Laughter', score: 0.5 }] },
    { start: 1.5, end: 3.5, labels: [{ label: 'Laughter', score: 0.4 }] },
    { start: 6, end: 8, labels: [{ label: 'Applause', score: 0.1 }] },
    { start: 9, end: 30, labels: [{ label: 'Music', score: 0.6 }] },
  ]);
  assert.deepEqual(s.map((x) => [x.text, x.start, x.end]), [['laughs', 0, 3.5], ['music', 9, 11.5]]);
});

test('exports are well-formed', () => {
  const words = wordsFromWhisper([
    { text: 'we', timestamp: [0, 0.3] }, { text: 'won!', timestamp: [0.3, 1.2] },
  ]);
  words[1].level = 3; words[1].manual = true;
  const project = react({ words, sounds: [{ id: 's1', text: 'cheering', start: 1.2, end: 3 }] }, null, { layout: 'long' });
  const srt = toSRT(project);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(srt, /WON!/);
  assert.match(srt, /\[cheering\]/);
  const vtt = toVTT(project);
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /<00:00:00\.300><b>WON!<\/b>/);
  const ass = toASS(project, { width: 1080, height: 1920, preset: 'pop' });
  assert.match(ass, /\[Script Info\][\s\S]*PlayResX: 1080[\s\S]*Dialogue: /);
  assert.match(ass, /\\fscx\d+/);
  assert.equal(formatTime(3661.5, ','), '01:01:01,500');
});
