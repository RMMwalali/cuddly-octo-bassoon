// Compresses the 16 kHz mono speech track to a small MP3 for cloud
// transcription: 32 kbit/s is about 240 KB a minute, so even a 15 minute video
// fits in one upload. Runs off the main thread so the page stays responsive.

import { Mp3Encoder } from './vendor/lamejs.js';
import { normalizePeak } from './cloud-words.js';

self.onmessage = ({ data }) => {
  const { id, samples, sampleRate = 16000, kbps = 32 } = data;
  try {
    const x = normalizePeak(samples);
    const enc = new Mp3Encoder(1, sampleRate, kbps);
    const block = 1152 * 8;
    const pcm = new Int16Array(block);
    const parts = [];
    let size = 0;
    for (let i = 0; i < x.length; i += block) {
      const n = Math.min(block, x.length - i);
      for (let k = 0; k < n; k++) {
        const v = Math.max(-1, Math.min(1, x[i + k]));
        pcm[k] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      const out = enc.encodeBuffer(n === block ? pcm : pcm.subarray(0, n));
      if (out.length) { parts.push(out.slice()); size += out.length; }
      if ((i / block) % 50 === 0) self.postMessage({ id, type: 'progress', done: i, total: x.length });
    }
    const tail = enc.flush();
    if (tail.length) { parts.push(tail.slice()); size += tail.length; }
    const mp3 = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { mp3.set(p, o); o += p.length; }
    self.postMessage({ id, type: 'result', mp3 }, [mp3.buffer]);
  } catch (e) {
    self.postMessage({ id, type: 'error', message: e?.message || String(e) });
  }
};
