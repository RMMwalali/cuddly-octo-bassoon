// Kaldi-compatible 80-bin log-mel filterbank features, the input expected by
// WeSpeaker / 3D-Speaker speaker-embedding models. Matches kaldi-native-fbank
// defaults: 25 ms frames every 10 ms, DC removal, 0.97 pre-emphasis, Povey
// window, power spectrum, 80 mel bins from 20 Hz to Nyquist, natural log.
// Pure JS so it runs in a worker and in Node tests.

const FRAME = 400; // 25 ms at 16 kHz
const SHIFT = 160; // 10 ms
const NFFT = 512;
const BINS = 80;
const EPS = 1.1920928955078125e-7; // float32 epsilon, Kaldi's log floor

let cache = null;
function tables(sampleRate, window) {
  if (cache && cache.sr === sampleRate && cache.window === window) return cache;
  const win = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    const a = (2 * Math.PI * i) / (FRAME - 1);
    win[i] = window === 'hamming' ? 0.54 - 0.46 * Math.cos(a) : Math.pow(0.5 - 0.5 * Math.cos(a), 0.85);
  }
  const mel = (f) => 1127 * Math.log(1 + f / 700);
  const lo = mel(20), hi = mel(sampleRate / 2);
  const delta = (hi - lo) / (BINS + 1);
  const nBins = NFFT / 2;
  const fftBinWidth = sampleRate / NFFT;
  const filters = [];
  for (let b = 0; b < BINS; b++) {
    const left = lo + b * delta, center = left + delta, right = center + delta;
    const w = new Float32Array(nBins);
    let first = -1, last = -1;
    for (let k = 0; k < nBins; k++) {
      const m = mel(fftBinWidth * k);
      if (m > left && m < right) {
        w[k] = m <= center ? (m - left) / (center - left) : (right - m) / (right - center);
        if (first < 0) first = k;
        last = k;
      }
    }
    filters.push({ w, first, last });
  }
  // FFT twiddles and bit reversal for NFFT
  const cos = new Float32Array(NFFT / 2), sin = new Float32Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / NFFT); sin[i] = -Math.sin((2 * Math.PI * i) / NFFT); }
  const rev = new Uint16Array(NFFT);
  const bits = Math.log2(NFFT);
  for (let i = 0; i < NFFT; i++) { let r = 0; for (let j = 0; j < bits; j++) r |= ((i >> j) & 1) << (bits - 1 - j); rev[i] = r; }
  cache = { sr: sampleRate, window, win, filters, cos, sin, rev };
  return cache;
}

function fft(re, im, T) {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = T.rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const tr = re[i + j + half] * T.cos[k] - im[i + j + half] * T.sin[k];
        const ti = re[i + j + half] * T.sin[k] + im[i + j + half] * T.cos[k];
        re[i + j + half] = re[i + j] - tr; im[i + j + half] = im[i + j] - ti;
        re[i + j] += tr; im[i + j] += ti;
      }
    }
  }
}

/**
 * samples: Float32Array in [-1, 1] at 16 kHz. Returns { data, frames } where
 * data is frames x 80, row-major. `scale` multiplies samples first (WeSpeaker
 * models expect 16-bit range, so 32768). `cmn` subtracts the per-bin mean.
 * `window` is 'povey' (Kaldi default) or 'hamming' (what WeSpeaker trains with).
 */
export function fbank(samples, { sampleRate = 16000, scale = 32768, cmn = true, window = 'povey' } = {}) {
  const T = tables(sampleRate, window);
  const frames = samples.length < FRAME ? 0 : 1 + Math.floor((samples.length - FRAME) / SHIFT);
  const data = new Float32Array(frames * BINS);
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  const x = new Float32Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const off = f * SHIFT;
    let mean = 0;
    for (let i = 0; i < FRAME; i++) { x[i] = samples[off + i] * scale; mean += x[i]; }
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) x[i] -= mean;
    for (let i = FRAME - 1; i > 0; i--) x[i] -= 0.97 * x[i - 1];
    x[0] -= 0.97 * x[0];
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = x[i] * T.win[i];
    fft(re, im, T);
    const row = f * BINS;
    for (let b = 0; b < BINS; b++) {
      const { w, first, last } = T.filters[b];
      let e = 0;
      for (let k = first; k <= last; k++) e += w[k] * (re[k] * re[k] + im[k] * im[k]);
      data[row + b] = Math.log(Math.max(e, EPS));
    }
  }
  if (cmn && frames) {
    for (let b = 0; b < BINS; b++) {
      let m = 0;
      for (let f = 0; f < frames; f++) m += data[f * BINS + b];
      m /= frames;
      for (let f = 0; f < frames; f++) data[f * BINS + b] -= m;
    }
  }
  return { data, frames, bins: BINS };
}
