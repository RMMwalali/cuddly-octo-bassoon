import { decodeToMono16k, wordFeatures, envelope } from './audio.js';
import { wordsFromWhisper, parseCues, wordsFromCues, react, soundsFromTags, scoreEmphasis, MOODS } from './reactive.js';
import { drawCaptions, pageAt } from './renderer.js';
import { PRESETS, DEFAULT_SETTINGS, MOOD_COLORS, MOOD_LABELS } from './presets.js';
import { toSRT, toVTT, toASS, download, burnIn } from './export.js';
import { Strip } from './strip.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ------------------------------------------------------------------ state
const state = {
  file: null,
  url: null,
  audio: null, // { samples, sampleRate, duration }
  project: null, // { words, pages, sounds }
  settings: loadSettings(),
  selected: null,
  subs: null, // imported subtitle text
  busy: false,
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('rc-settings') || 'null');
    if (s) return { ...DEFAULT_SETTINGS, ...s, react: { ...DEFAULT_SETTINGS.react, ...s.react } };
  } catch {}
  return structuredClone(DEFAULT_SETTINGS);
}
function saveSettings() {
  try { localStorage.setItem('rc-settings', JSON.stringify(state.settings)); } catch {}
}

// ------------------------------------------------------------------ worker
let worker = null;
let reqId = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      data.type === 'error' ? reject(new Error(data.message)) : resolve(data);
      return;
    }
    onWorkerEvent(data);
  };
  worker.onerror = (e) => {
    for (const { reject } of pending.values()) reject(new Error(e.message || 'The speech model could not start in this browser.'));
    pending.clear();
  };
  return worker;
}
function ask(msg, transfer) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

const downloads = new Map();
function onWorkerEvent(d) {
  if (d.type === 'status') work(d.text);
  else if (d.type === 'download') {
    downloads.set(d.file, { loaded: d.loaded, total: d.total, done: d.status === 'done' });
    let loaded = 0, total = 0;
    for (const f of downloads.values()) { loaded += f.loaded; total += f.total; }
    if (total > 0) work(null, loaded / total, `Downloading ${d.kind} model, ${mb(loaded)} of ${mb(total)}. This happens once.`);
  } else if (d.type === 'transcribe-progress') work(null, d.total ? d.done / d.total : null, '');
  else if (d.type === 'tag-progress') work(null, d.done / d.total, 'Listening for laughs, applause and other sounds');
  else if (d.type === 'partial') {
    // Show words as they arrive so people see it working.
    state.project = { words: wordsFromWhisper(d.chunks), pages: [], sounds: [] };
    react(state.project, null, { layout: state.settings.layout });
    refresh();
  }
}
const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;

// ------------------------------------------------------------------ elements
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const strip = new Strip($('#stripWrap'), {
  onSeek: (t) => seek(t),
  onPick: (id) => { selectWord(id); showTab('words'); },
});

// ------------------------------------------------------------------ progress overlay
function work(text, frac, detail) {
  $('#work').hidden = false;
  if (text) $('#workText').textContent = text;
  const bar = $('#workBar').parentElement;
  if (frac === undefined) {} else if (frac === null) bar.classList.add('indeterminate');
  else { bar.classList.remove('indeterminate'); $('#workBar').style.width = `${Math.round(frac * 100)}%`; }
  if (detail !== undefined) $('#workDetail').textContent = detail;
}
const workDone = () => { $('#work').hidden = true; };

let toastTimer;
function toast(msg, error = false, ms = 4500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ------------------------------------------------------------------ load + analyze
async function openFile(file) {
  if (!file) return;
  if (/\.(srt|vtt)$/i.test(file.name)) return setSubs(file);
  if (state.busy) return;
  state.busy = true;
  state.file = file;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file);
  state.project = null;
  state.selected = null;
  $('#drop').hidden = true;
  $('#player').hidden = false;
  $('#newBtn').hidden = false;
  $('#fileName').hidden = false;
  $('#fileName').textContent = file.name;
  $('#exportBtn').disabled = true;
  video.src = state.url;
  await new Promise((res) => { video.onloadedmetadata = res; video.onerror = res; });
  sizeOverlay();
  try {
    work('Reading audio…', null, '');
    state.audio = await decodeToMono16k(file);
    const env = envelope(state.audio.samples, state.audio.sampleRate);
    strip.set(null, state.audio.duration, env);

    let words;
    if (state.subs) {
      words = wordsFromCues(parseCues(state.subs));
      if (!words.length) throw new Error('No captions found in that subtitle file.');
    } else {
      work('Loading speech model…', null, '');
      downloads.clear();
      const samples = state.audio.samples.slice();
      const res = await ask({ type: 'transcribe', samples, model: $('#model').value, language: $('#language').value }, [samples.buffer]);
      words = wordsFromWhisper(res.chunks);
      if (!words.length) throw new Error('No speech was found in this video.');
    }
    state.project = { words, pages: [], sounds: [] };
    analyze(true);
    workDone();
    $('#exportBtn').disabled = false;
    if ($('#detectSounds').checked) await detectSounds();
    else $('#tagSoundsBtn').hidden = false;
  } catch (e) {
    console.error(e);
    workDone();
    toast(friendlyError(e), true, 9000);
    if (state.project?.words.length) $('#exportBtn').disabled = false;
  } finally {
    state.busy = false;
  }
}

function friendlyError(e) {
  const m = e?.message || String(e);
  if (/decode|EncodingError|Unable to decode/i.test(m)) return 'This browser cannot read the audio in that file. Try an MP4 or WebM, or convert it first.';
  if (/fetch|network|Failed to load/i.test(m)) return 'The speech model could not be downloaded. Check your connection and try again.';
  if (/memory|allocation/i.test(m)) return 'Ran out of memory. Pick the Fast accuracy option or use a shorter clip.';
  return m;
}

async function detectSounds() {
  if (!state.audio || state.busy && !state.project) return;
  $('#tagSoundsBtn').hidden = true;
  try {
    work('Loading sound model…', null, '');
    downloads.clear();
    const samples = state.audio.samples.slice();
    const res = await ask({ type: 'tag', samples }, [samples.buffer]);
    state.project.sounds = soundsFromTags(res.windows);
    workDone();
    refresh();
    toast(state.project.sounds.length ? `Found ${state.project.sounds.length} sound${state.project.sounds.length > 1 ? 's' : ''} to tag.` : 'No laughs, applause or other sounds were found.');
  } catch (e) {
    console.error(e);
    workDone();
    $('#tagSoundsBtn').hidden = false;
    toast(`Sound detection failed: ${friendlyError(e)}`, true, 8000);
  }
}

/** (Re)score emphasis and regroup. Features are measured once per word. */
function analyze(measure = false) {
  const p = state.project;
  if (!p) return;
  if (measure && state.audio) {
    const feats = wordFeatures(p.words, state.audio.samples, state.audio.sampleRate);
    p.words.forEach((w, i) => (w.f = feats[i]));
  }
  scoreEmphasis(p.words, p.words.map((w) => w.f || { db: -100, hz: 0 }), { sensitivity: state.settings.sensitivity });
  react(p, null, { layout: state.settings.layout });
  refresh();
}

function regroup() {
  if (!state.project) return;
  react(state.project, null, { layout: state.settings.layout });
  refresh();
}

// ------------------------------------------------------------------ render
function sizeOverlay() {
  const vw = video.videoWidth || 1080, vh = video.videoHeight || 1920;
  const k = Math.min(1, 1440 / Math.max(vw, vh));
  overlay.width = Math.round(vw * k);
  overlay.height = Math.round(vh * k);
  $('#frame').style.setProperty('--ar', String(vw / vh));
}

let lastPageId = null;
function draw() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const p = state.project;
  const t = video.currentTime;
  if (p) {
    p._byId = new Map(p.words.map((w) => [w.id, w]));
    const page = drawCaptions(octx, p, t, state.settings);
    const id = page?.id || null;
    if (id !== lastPageId) {
      lastPageId = id;
      $$('.page.now').forEach((el) => el.classList.remove('now'));
      if (id) {
        const el = document.querySelector(`.page[data-id="${id}"]`);
        el?.classList.add('now');
        if (!video.paused && el && !$('[data-pane=words]').hidden) el.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  strip.setTime(t, !video.paused);
  $('#timeLabel').textContent = `${clock(t)} / ${clock(video.duration || 0)}`;
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function loop() {
  draw();
  if (!video.paused) requestAnimationFrame(loop);
}
video.addEventListener('play', () => { $('#playBtn').classList.add('playing'); $('#playBtn').setAttribute('aria-label', 'Pause'); loop(); });
video.addEventListener('pause', () => { $('#playBtn').classList.remove('playing'); $('#playBtn').setAttribute('aria-label', 'Play'); draw(); });
video.addEventListener('seeked', draw);
video.addEventListener('loadeddata', draw);

function seek(t) {
  video.currentTime = t;
  draw();
}

function refresh() {
  const p = state.project;
  if (p) strip.set(p, state.audio?.duration || video.duration || 1);
  renderPages();
  renderStats();
  draw();
}

// ------------------------------------------------------------------ words panel
function renderPages() {
  const ol = $('#pages');
  const p = state.project;
  ol.innerHTML = '';
  if (!p) return;
  const byId = new Map(p.words.map((w) => [w.id, w]));
  const frag = document.createDocumentFragment();
  const items = [
    ...p.pages.map((pg) => ({ t: pg.start, pg })),
    ...(p.sounds || []).map((s) => ({ t: s.start, s })),
  ].sort((a, b) => a.t - b.t);
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'page';
    const time = document.createElement('time');
    time.textContent = clock(it.t);
    const chips = document.createElement('div');
    chips.className = 'chips';
    if (it.s) {
      li.style.setProperty('--mood', 'transparent');
      const c = document.createElement('span');
      c.className = 'chip sound';
      c.textContent = `[${it.s.text}]`;
      const x = document.createElement('button');
      x.className = 'chip';
      x.textContent = 'Remove';
      x.style.fontSize = '12px';
      x.onclick = () => { p.sounds = p.sounds.filter((s) => s !== it.s); refresh(); };
      chips.append(c, x);
    } else {
      const pg = it.pg;
      li.dataset.id = pg.id;
      const moodColor = MOOD_COLORS[pg.mood];
      li.style.setProperty('--mood', moodColor || 'var(--line)');
      if (moodColor) li.style.setProperty('--mood-c', moodColor);
      for (const id of pg.wordIds) {
        const w = byId.get(id);
        const b = document.createElement('button');
        b.className = `chip l${w.level}${w.manual ? ' manual' : ''}${w.id === state.selected ? ' sel' : ''}`;
        b.textContent = w.text;
        b.dataset.word = w.id;
        b.onclick = () => selectWord(w.id);
        chips.append(b);
      }
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Mood for this caption');
      for (const m of MOODS) {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = MOOD_LABELS[m] + (m === pg.moodAuto && pg.moodManual ? ' (auto)' : '');
        if (m === pg.mood) o.selected = true;
        sel.append(o);
      }
      sel.onchange = () => { pg.mood = sel.value; pg.moodManual = sel.value !== pg.moodAuto; refresh(); };
      chips.append(sel);
    }
    li.append(time, chips);
    frag.append(li);
  }
  ol.append(frag);
  lastPageId = null;
}

function selectWord(id) {
  const w = state.project?.words.find((x) => x.id === id);
  state.selected = w ? id : null;
  strip.selected = state.selected;
  $$('.chip.sel').forEach((c) => c.classList.remove('sel'));
  $('#inspector').hidden = !w;
  $('#wordsHelp').hidden = !!w;
  if (!w) return strip.draw();
  document.querySelector(`.chip[data-word="${id}"]`)?.classList.add('sel');
  $('#wordText').value = w.text;
  setSeg('#wordLevel', String(w.level));
  $('#wordAuto').disabled = !w.manual;
  if (video.paused) seek(w.start + 0.01);
  else strip.draw();
}

$('#wordText').addEventListener('change', (e) => {
  const w = selected();
  if (!w) return;
  const text = e.target.value.trim();
  if (!text) return;
  w.text = text;
  regroup();
  selectWord(w.id);
});
$('#wordLevel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  const w = selected();
  if (!b || !w) return;
  w.level = Number(b.dataset.v);
  w.manual = w.level !== w.auto.level;
  regroup();
  selectWord(w.id);
});
$('#wordAuto').addEventListener('click', () => {
  const w = selected();
  if (!w) return;
  w.manual = false;
  w.level = w.auto.level;
  regroup();
  selectWord(w.id);
});
$('#wordDelete').addEventListener('click', () => {
  const w = selected();
  if (!w) return;
  state.project.words = state.project.words.filter((x) => x !== w);
  selectWord(null);
  regroup();
});
const selected = () => state.project?.words.find((w) => w.id === state.selected);

// ------------------------------------------------------------------ settings UI
function setSeg(sel, value) {
  $$(`${sel} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
}

function buildPresets() {
  const box = $('#presets');
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.v = key;
    const c = document.createElement('canvas');
    c.width = 300; c.height = 128;
    const label = document.createElement('span');
    label.innerHTML = `${p.label}<small>${p.hint}</small>`;
    b.append(c, label);
    b.onclick = () => { state.settings.preset = key; saveSettings(); syncSettings(); draw(); };
    box.append(b);
  }
  drawPresetThumbs();
}

const SAMPLE = (() => {
  const words = [
    { id: 'a', text: 'this', start: 0, end: 0.3, level: 0 },
    { id: 'b', text: 'is', start: 0.3, end: 0.5, level: 0 },
    { id: 'c', text: 'huge!', start: 0.5, end: 2, level: 3 },
  ];
  return { words, pages: [{ id: 'pg', wordIds: ['a', 'b', 'c'], start: 0, end: 3, mood: 'excited' }], sounds: [] };
})();
function drawPresetThumbs() {
  $$('.preset').forEach((b) => {
    const c = b.querySelector('canvas');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    drawCaptions(ctx, SAMPLE, 0.75, { ...state.settings, sizeRef: 400, preset: b.dataset.v, position: 'middle', layout: 'long', react: { ...state.settings.react, motion: false, sounds: false } });
  });
}

function syncSettings() {
  const s = state.settings;
  $$('.preset').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === s.preset)));
  setSeg('#position', s.position);
  setSeg('#layout', s.layout);
  $$('[data-react]').forEach((i) => (i.checked = !!s.react[i.dataset.react]));
  $('#sensitivity').value = s.sensitivity;
}

$('#position').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.settings.position = b.dataset.v; saveSettings(); syncSettings(); draw();
});
$('#layout').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.settings.layout = b.dataset.v; saveSettings(); syncSettings(); regroup();
});
$$('[data-react]').forEach((i) => i.addEventListener('change', () => {
  state.settings.react[i.dataset.react] = i.checked; saveSettings(); drawPresetThumbs(); draw();
}));
let sensTimer;
$('#sensitivity').addEventListener('input', (e) => {
  state.settings.sensitivity = Number(e.target.value);
  saveSettings();
  clearTimeout(sensTimer);
  sensTimer = setTimeout(() => analyze(false), 60);
});
$('#tagSoundsBtn').addEventListener('click', detectSounds);

function renderStats() {
  const p = state.project;
  const el = $('#reactStats');
  if (!p || !p.words.length) { el.textContent = ''; return; }
  const n = [0, 0, 0, 0];
  p.words.forEach((w) => n[w.level]++);
  el.textContent = `${p.words.length} words: ${n[1]} stressed, ${n[2]} strong, ${n[3]} shouted.`;
}

function buildLegend() {
  const notes = {
    neutral: 'Steady delivery',
    excited: 'Loud and high, or exclamations',
    angry: 'Loud and low, or harsh words',
    soft: 'Quiet, or sad words',
    question: 'Ends in a question',
  };
  $('#legend').innerHTML = MOODS.map((m) => `<li><i style="background:${MOOD_COLORS[m] || 'var(--neutral)'}"></i>${MOOD_LABELS[m]} <span>${notes[m]}</span></li>`).join('');
}

function showTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((t) => (t.hidden = t.dataset.pane !== name));
}
$('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

// ------------------------------------------------------------------ files in
function setSubs(file) {
  file.text().then((txt) => {
    state.subs = txt;
    const n = parseCues(txt).length;
    $('#subsName').textContent = n ? `${file.name}: ${n} captions. Now choose the video.` : `${file.name} has no captions I can read.`;
    if (!n) state.subs = null;
    if (n && state.file && state.audio && !state.busy) {
      // Video already open: swap in the imported text.
      state.project = { words: wordsFromCues(parseCues(txt)), pages: [], sounds: state.project?.sounds || [] };
      analyze(true);
      $('#exportBtn').disabled = false;
      toast(`Using ${n} captions from ${file.name}.`);
    }
  });
}
$('#fileInput').addEventListener('change', (e) => openFile(e.target.files[0]));
$('#subsInput').addEventListener('change', (e) => e.target.files[0] && setSubs(e.target.files[0]));

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  const subs = files.find((f) => /\.(srt|vtt)$/i.test(f.name));
  const media = files.find((f) => /^(video|audio)\//.test(f.type) || /\.(mp4|mov|webm|mkv|m4a|mp3|wav)$/i.test(f.name));
  if (subs) setSubs(subs);
  if (media) openFile(media);
});

$('#newBtn').addEventListener('click', () => {
  if (state.busy) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  Object.assign(state, { file: null, audio: null, project: null, selected: null, subs: null });
  $('#subsName').textContent = '';
  $('#fileInput').value = '';
  $('#drop').hidden = false;
  $('#player').hidden = true;
  $('#newBtn').hidden = true;
  $('#fileName').hidden = true;
  $('#exportBtn').disabled = true;
  $('#tagSoundsBtn').hidden = true;
  renderPages();
});

// ------------------------------------------------------------------ transport
$('#playBtn').addEventListener('click', () => (video.paused ? video.play() : video.pause()));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || $('#player').hidden) return;
  if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  if (e.code === 'ArrowLeft') seek(Math.max(0, video.currentTime - (e.shiftKey ? 5 : 1)));
  if (e.code === 'ArrowRight') seek(Math.min(video.duration, video.currentTime + (e.shiftKey ? 5 : 1)));
});

// ------------------------------------------------------------------ export
const menu = $('#exportMenu');
const menuList = menu.querySelector('.menu-list');
$('#exportBtn').addEventListener('click', () => {
  const open = menuList.hidden;
  menuList.hidden = !open;
  $('#exportBtn').setAttribute('aria-expanded', String(open));
  if (open) menuList.querySelector('button').focus();
});
document.addEventListener('click', (e) => { if (!menu.contains(e.target)) { menuList.hidden = true; $('#exportBtn').setAttribute('aria-expanded', 'false'); } });
menuList.addEventListener('keydown', (e) => { if (e.key === 'Escape') { menuList.hidden = true; $('#exportBtn').focus(); } });

const baseName = () => (state.file?.name || 'captions').replace(/\.[^.]+$/, '');
menuList.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-export]');
  if (!b || !state.project) return;
  menuList.hidden = true;
  const kind = b.dataset.export;
  const p = state.project;
  const s = state.settings;
  if (kind === 'srt') download(`${baseName()}.srt`, toSRT(p), 'application/x-subrip');
  if (kind === 'vtt') download(`${baseName()}.vtt`, toVTT(p), 'text/vtt');
  if (kind === 'ass') download(`${baseName()}.ass`, toASS(p, { width: video.videoWidth || 1080, height: video.videoHeight || 1920, preset: s.preset, position: s.position, react: s.react }), 'text/plain');
  if (kind === 'video') exportVideo();
});

async function exportVideo() {
  if (state.busy) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    toast('This browser cannot record video. Use Chrome, Edge or a recent Safari, or export the .ass file.', true, 8000);
    return;
  }
  state.busy = true;
  video.pause();
  const ctrl = new AbortController();
  work('Rendering your video…', 0, 'Plays once in real time. Keep this tab open and visible.');
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost small';
  cancel.textContent = 'Cancel';
  cancel.style.marginTop = '10px';
  cancel.onclick = () => ctrl.abort();
  $('#work').append(cancel);
  try {
    await document.fonts.load(`${PRESETS[state.settings.preset].weight} 40px ${PRESETS[state.settings.preset].font}`).catch(() => {});
    const p = state.project;
    p._byId = new Map(p.words.map((w) => [w.id, w]));
    const { blob, ext } = await burnIn(state.url, (ctx, t) => drawCaptions(ctx, p, t, state.settings), {
      signal: ctrl.signal,
      onProgress: (f) => work(null, f),
    });
    download(`${baseName()}-captioned.${ext}`, blob);
    toast(ext === 'mp4' ? 'Video exported.' : 'Video exported as WebM. Most apps accept it; convert to MP4 if one does not.');
  } catch (e) {
    if (e.name !== 'AbortError') { console.error(e); toast(`Export failed: ${e.message}`, true, 8000); }
  } finally {
    cancel.remove();
    workDone();
    state.busy = false;
  }
}

// ------------------------------------------------------------------ boot
buildPresets();
buildLegend();
syncSettings();
document.fonts?.ready.then(() => { drawPresetThumbs(); draw(); });
window.addEventListener('beforeunload', (e) => { if (state.busy) e.preventDefault(); });

// Test hook: load a project without running the models (used by the browser tests).
window.__rc = { state, openFile, analyze, refresh };
