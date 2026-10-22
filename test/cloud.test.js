import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST, fromDeepgram, fromWhisperJSON, MAX_BYTES } from '../api/transcribe.js';
import { cloudChunks, cloudSegments, normalizePeak, LANG_CODES } from '../src/cloud-words.js';
import { wordsFromWhisper, assignSpeakers } from '../src/cwi.js';

const DEEPGRAM = {
  results: {
    channels: [{
      detected_language: 'en',
      alternatives: [{
        words: [
          { word: 'hello', punctuated_word: 'Hello,', start: 0.1, end: 0.4, confidence: 0.99, speaker: 0 },
          { word: 'there', punctuated_word: 'there.', start: 0.45, end: 0.8, confidence: 0.98, speaker: 0 },
          { word: 'hi', punctuated_word: 'Hi!', start: 1.2, end: 1.5, confidence: 0.97, speaker: 1 },
          { word: 'how', punctuated_word: 'How', start: 1.6, end: 1.8, confidence: 0.97, speaker: 1 },
          { word: 'are', punctuated_word: 'are', start: 1.8, end: 1.95, confidence: 0.97, speaker: 1 },
          { word: 'you', punctuated_word: 'you?', start: 1.95, end: 2.2, confidence: 0.97, speaker: 1 },
          { word: 'good', punctuated_word: 'Good.', start: 2.6, end: 2.9, confidence: 0.97, speaker: 0 },
          { word: 'thanks', punctuated_word: 'Thanks.', start: 2.95, end: 3.3, confidence: 0.97, speaker: 0 },
        ],
      }],
    }],
  },
};

const GROQ = {
  language: 'English',
  segments: [{ start: 0, end: 2, text: ' Well, hello there! How are you?' }],
  words: [
    { word: 'Well', start: 0, end: 0.3 }, { word: 'hello', start: 0.35, end: 0.6 },
    { word: 'there', start: 0.6, end: 0.9 }, { word: 'How', start: 1.1, end: 1.3 },
    { word: 'are', start: 1.3, end: 1.45 }, { word: 'you', start: 1.45, end: 1.8 },
  ],
};

test('Deepgram words keep punctuation, times and speakers', () => {
  const out = fromDeepgram(DEEPGRAM);
  assert.equal(out.speakers, true);
  assert.equal(out.language, 'en');
  assert.deepEqual(out.words.map((w) => w.text).join(' '), 'Hello, there. Hi! How are you? Good. Thanks.');
  assert.deepEqual([...new Set(out.words.map((w) => w.speaker))], [0, 1]);
});

test('Whisper JSON words get their punctuation back from the segments', () => {
  const out = fromWhisperJSON(GROQ, 'groq');
  assert.equal(out.words.map((w) => w.text).join(' '), 'Well, hello there! How are you?');
  assert.equal(out.speakers, false);
});

test('cloud words become app words with speakers S1/S2', () => {
  const { words: raw } = fromDeepgram(DEEPGRAM);
  const words = wordsFromWhisper(cloudChunks(raw));
  assert.equal(words.length, 8);
  assignSpeakers(words, cloudSegments(raw), { powerset: false, minShare: 0.02, minWords: 2 });
  assert.deepEqual(words.map((w) => w.speaker), ['S1', 'S1', 'S2', 'S2', 'S2', 'S2', 'S1', 'S1']);
});

test('a speaker limit folds extra voices into the previous speaker', () => {
  const raw = [
    { text: 'a', start: 0, end: 1, speaker: 0 }, { text: 'b', start: 1, end: 2, speaker: 0 },
    { text: 'c', start: 2, end: 2.2, speaker: 2 }, { text: 'd', start: 2.3, end: 4, speaker: 1 },
    { text: 'e', start: 4, end: 5, speaker: 1 },
  ];
  const ids = new Set(cloudSegments(raw, 2).map((s) => s.id));
  assert.deepEqual([...ids].sort(), [1, 2]);
  assert.equal(cloudSegments(raw, 2)[0].end, 2.2); // 'c' joined speaker 0's segment
});

test('peak normalisation lifts quiet audio and leaves silence alone', () => {
  const quiet = Float32Array.from({ length: 1000 }, (_, i) => 0.05 * Math.sin(i / 5));
  const out = normalizePeak(quiet);
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak - 0.9) < 0.01);
  const silent = new Float32Array(100);
  assert.equal(normalizePeak(silent), silent);
  assert.equal(LANG_CODES.swahili, 'sw');
});

// ---------------------------------------------------------------- the API

async function withEnv(env, fn) {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of ['DEEPGRAM_API_KEY', 'GROQ_API_KEY']) delete process.env[k];
    Object.assign(process.env, saved);
    globalThis.fetch = realFetch;
  }
}

const audioReq = (bytes = 1000, headers = {}, query = '') =>
  new Request(`https://rc.example/api/transcribe${query}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/mpeg', host: 'rc.example', ...headers },
    body: new Uint8Array(bytes),
  });

test('the API says 501 when no key is set, so the page uses the device', async () => {
  await withEnv({}, async () => {
    assert.equal((await GET()).status, 501);
    assert.equal((await POST(audioReq())).status, 501);
  });
});

test('the API forwards audio to Deepgram and returns normalised words', async () => {
  await withEnv({ DEEPGRAM_API_KEY: 'test-key' }, async () => {
    const info = await (await GET()).json();
    assert.equal(info.provider, 'deepgram');
    let seen;
    globalThis.fetch = async (url, opts) => {
      seen = { url: String(url), opts };
      return new Response(JSON.stringify(DEEPGRAM), { status: 200 });
    };
    const res = await POST(audioReq(2000, { origin: 'https://rc.example' }, '?language=en'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.words.length, 8);
    assert.match(seen.url, /model=nova-3/);
    assert.match(seen.url, /diarize=true/);
    assert.match(seen.url, /language=en/);
    assert.equal(seen.opts.headers.Authorization, 'Token test-key');
  });
});

test('the API rejects other sites, non-audio and oversized uploads', async () => {
  await withEnv({ DEEPGRAM_API_KEY: 'k' }, async () => {
    globalThis.fetch = async () => { throw new Error('should not be called'); };
    assert.equal((await POST(audioReq(10, { origin: 'https://evil.example' }))).status, 403);
    assert.equal((await POST(audioReq(10, { 'content-type': 'text/plain' }))).status, 415);
    assert.equal((await POST(audioReq(MAX_BYTES + 1))).status, 413);
  });
});

test('the API falls back to Groq when Deepgram fails, and routes Swahili to Groq', async () => {
  await withEnv({ DEEPGRAM_API_KEY: 'k', GROQ_API_KEY: 'g' }, async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('deepgram')) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify(GROQ), { status: 200 });
    };
    let body = await (await POST(audioReq())).json();
    assert.equal(body.provider, 'groq-whisper-large-v3-turbo');
    assert.deepEqual(calls.map((u) => new URL(u).host), ['api.deepgram.com', 'api.groq.com']);
    calls.length = 0;
    body = await (await POST(audioReq(100, {}, '?language=sw'))).json();
    assert.deepEqual(calls.map((u) => new URL(u).host), ['api.groq.com']);
  });
});
