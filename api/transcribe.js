// Cloud transcription for Reactive Captions (a Vercel Function).
//
// The page sends a small, compressed audio track (MP3, mono 16 kHz) and gets
// back word-timed text, plus who spoke each word when the provider can tell.
// Keys live only in Vercel's environment variables, never in the page:
//
//   DEEPGRAM_API_KEY  Deepgram Nova-3: words + speakers in one call (preferred)
//   GROQ_API_KEY      Groq Whisper large-v3-turbo: words only (speakers are then
//                     found on the device)
//
// With no key set, GET answers 501 and the page transcribes on the device.

export const MAX_BYTES = 4_400_000; // Vercel rejects request bodies over 4.5 MB
const DEEPGRAM_LANGS = new Set(['en', 'es', 'fr', 'de', 'hi', 'pt', 'it', 'nl', 'ja', 'ko', 'ru', 'tr', 'pl', 'sv', 'da', 'no', 'fi', 'id', 'vi', 'uk']);

export function providers(env = process.env) {
  const list = [];
  if (env.DEEPGRAM_API_KEY) list.push('deepgram');
  if (env.GROQ_API_KEY) list.push('groq');
  return list;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function GET() {
  const list = providers();
  if (!list.length) return json({ ok: false, reason: 'No transcription key is set on the server.' }, 501);
  return json({ ok: true, provider: list[0], maxBytes: MAX_BYTES });
}

export async function POST(request) {
  const list = providers();
  if (!list.length) return json({ error: 'No transcription key is set on the server.' }, 501);

  // Only this site's own pages may use the key.
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (origin && host && new URL(origin).host !== host) return json({ error: 'Not allowed.' }, 403);

  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^audio\/(mpeg|mp3|wav|x-wav|webm|ogg|mp4|m4a)$/.test(type)) return json({ error: 'Send audio.' }, 415);
  const audio = new Uint8Array(await request.arrayBuffer());
  if (!audio.length) return json({ error: 'Empty audio.' }, 400);
  if (audio.length > MAX_BYTES) return json({ error: 'Audio too long for cloud transcription.' }, 413);

  const url = new URL(request.url);
  const language = (url.searchParams.get('language') || '').toLowerCase().slice(0, 5) || null;
  const speakers = url.searchParams.get('speakers') !== '0';

  // Deepgram first when it knows the language; Groq otherwise or as a backup.
  let order = list;
  if (language && !DEEPGRAM_LANGS.has(language) && list.includes('groq')) order = ['groq', ...list.filter((p) => p !== 'groq')];
  let lastError = null;
  for (const p of order) {
    try {
      const out = p === 'deepgram'
        ? await deepgram(audio, type, { language, speakers, key: process.env.DEEPGRAM_API_KEY })
        : await groq(audio, type, { language, key: process.env.GROQ_API_KEY });
      return json(out);
    } catch (e) {
      lastError = e;
      console.error(`${p} failed:`, e?.message || e);
    }
  }
  return json({ error: 'Cloud transcription failed.', detail: String(lastError?.message || lastError).slice(0, 200) }, 502);
}

export async function deepgram(audio, type, { language, speakers, key, fetchImpl = fetch }) {
  const q = new URLSearchParams({ model: 'nova-3', smart_format: 'true', punctuate: 'true' });
  if (speakers) q.set('diarize', 'true');
  if (language) q.set('language', language);
  else q.set('detect_language', 'true');
  const res = await fetchImpl(`https://api.deepgram.com/v1/listen?${q}`, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': type === 'audio/mp3' ? 'audio/mpeg' : type },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return fromDeepgram(await res.json());
}

export function fromDeepgram(data) {
  const ch = data?.results?.channels?.[0];
  const alt = ch?.alternatives?.[0];
  const words = (alt?.words || []).map((w) => ({
    text: w.punctuated_word || w.word,
    start: w.start,
    end: w.end,
    ...(Number.isInteger(w.speaker) ? { speaker: w.speaker } : {}),
  }));
  return {
    provider: 'deepgram-nova-3',
    language: ch?.detected_language || null,
    speakers: words.some((w) => 'speaker' in w),
    words,
  };
}

export async function groq(audio, type, { language, key, fetchImpl = fetch }) {
  const form = new FormData();
  const ext = type.includes('wav') ? 'wav' : type.includes('webm') ? 'webm' : 'mp3';
  form.append('file', new Blob([audio], { type }), `audio.${ext}`);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  const res = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return fromWhisperJSON(await res.json(), 'groq-whisper-large-v3-turbo');
}

const bare = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * OpenAI-style verbose_json: `words` carry times but no punctuation, while
 * `segments` carry punctuated text. Put the punctuation back on the words.
 */
export function fromWhisperJSON(data, provider) {
  const raw = (data?.words || []).filter((w) => w.word?.trim());
  const tokens = [];
  for (const s of data?.segments || []) for (const t of (s.text || '').trim().split(/\s+/)) if (t) tokens.push(t);
  let k = 0;
  const words = raw.map((w) => {
    const plain = w.word.trim();
    let text = plain;
    for (let look = k; look < Math.min(tokens.length, k + 4); look++) {
      if (bare(tokens[look]) === bare(plain)) { text = tokens[look]; k = look + 1; break; }
    }
    return { text, start: w.start, end: w.end };
  });
  return { provider, language: data?.language || null, speakers: false, words };
}
