import { decodeToMono16k, wordFeatures, envelope } from './audio.js';
import {
  wordsFromWhisper, parseCues, wordsFromCues, assignSpeakers, analyze, fromCWIDocument, SPEAKER_COLORS, CWI,
} from './cwi.js';
import { drawCaptions, DEFAULT_SETTINGS, MOTIONS } from './renderer.js';
import { FONTS, getFont, ensureFont, cssUrl, familyStack } from './fonts.js';
import { validate, contrastRatio, RULE_LIST } from './validate.js';
import { toSRT, toVTT, toASS, toCWIJSON, download, burnIn } from './export.js';
import { toCWIDocument } from './cwi.js';
import { Strip } from './strip.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ------------------------------------------------------------------ state
const state = {
  file: null,
  url: null,
  audio: null, // { samples, sampleRate, duration }
  project: null, // { words, cast, captions }
  settings: loadSettings(),
  selected: null,
  subs: null, // { kind: 'cues' | 'cwi', text, name }
  language: null,
  source: 'browser-whisper+pyannote', // what produced the words, for the CWI metadata
  busy: false,
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('rc-cwi-settings') || 'null');
    if (s) return { ...DEFAULT_SETTINGS, ...s };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}
function saveSettings() {
  try { localStorage.setItem('rc-cwi-settings', JSON.stringify(state.settings)); } catch {}
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
    for (const { reject } of pending.values()) reject(new Error(e.message || 'The models could not start in this browser.'));
    pending.clear();
    worker = null;
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
    downloads.set(d.file, { loaded: d.loaded, total: d.total });
    let loaded = 0, total = 0;
    for (const f of downloads.values()) { loaded += f.loaded; total += f.total; }
    if (total > 0) work(null, loaded / total, `Downloading the ${d.kind} model, ${mb(loaded)} of ${mb(total)}. This happens once.`);
  } else if (d.type === 'transcribe-progress') work(null, d.total ? d.done / d.total : null, '');
  else if (d.type === 'partial') {
    // Show words as they arrive so people see it working.
    state.project = analyze({ words: wordsFromWhisper(d.chunks), cast: [] }, state.settings);
    refresh();
  }
}
const mb = (b) => `${Math.max(1, Math.round(b / 1048576))} MB`;

// ------------------------------------------------------------------ elements
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const strip = new Strip($('#stripWrap'), {
  onSeek: (t) => seek(t),
  onPick: (id) => { selectWord(id); showTab('words'); },
});

function work(text, frac, detail) {
  $('#work').hidden = false;
  if (text) $('#workText').textContent = text;
  const bar = $('#workBar').parentElement;
  if (frac === null) bar.classList.add('indeterminate');
  else if (frac !== undefined) { bar.classList.remove('indeterminate'); $('#workBar').style.width = `${Math.round(frac * 100)}%`; }
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
  if (/\.(srt|vtt|json)$/i.test(file.name)) return setSubs(file);
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
    strip.set(null, state.audio.duration, envelope(state.audio.samples, state.audio.sampleRate));

    if (state.subs?.kind === 'cwi') {
      // A CWI document already has its styling; keep it exactly.
      state.project = fromCWIDocument(JSON.parse(state.subs.text));
      state.language = state.project.language;
      state.source = JSON.parse(state.subs.text).metadata?.extractor_backend || 'imported-cwi';
      analyze(state.project, state.settings);
    } else {
      let words;
      if (state.subs) {
        words = wordsFromCues(parseCues(state.subs.text));
        if (!words.length) throw new Error('No captions were found in that subtitle file.');
        state.source = 'imported-subtitles+browser-prosody';
      } else {
        work('Loading speech model…', null, '');
        downloads.clear();
        const samples = state.audio.samples.slice();
        const res = await ask({ type: 'transcribe', samples, model: $('#model').value, language: $('#language').value }, [samples.buffer]);
        words = wordsFromWhisper(res.chunks);
        if (!words.length) throw new Error('No speech was found in this video.');
        state.language = $('#language').value === 'auto' ? null : $('#language').value;
        state.source = $('#speakerMode').value === 'auto' ? 'browser-whisper+pyannote' : 'browser-whisper';
      }
      const named = words.some((w) => w.speakerName);
      if ($('#speakerMode').value === 'auto' && !named) {
        try {
          downloads.clear();
          const samples = state.audio.samples.slice();
          const res = await ask({ type: 'diarize', samples }, [samples.buffer]);
          assignSpeakers(words, res.segments);
        } catch (e) {
          console.error(e);
          toast(`Speaker detection didn't work (${friendlyError(e)}). Everyone is one speaker for now; you can reassign lines in Words.`, true, 9000);
        }
      }
      work('Measuring pitch and volume…', null, '');
      await new Promise((r) => setTimeout(r, 30));
      const feats = wordFeatures(words, state.audio.samples, state.audio.sampleRate);
      words.forEach((w, i) => (w.f = feats[i]));
      state.project = analyze({ words, cast: [] }, state.settings);
    }
    workDone();
    $('#exportBtn').disabled = false;
    refresh();
    if (state.project.cast.length > 1) toast(`Found ${state.project.cast.length} speakers. Rename them in Speakers.`);
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
  if (/fetch|network|Failed to load|NetworkError/i.test(m)) return 'A model could not be downloaded. Check your connection and try again.';
  if (/memory|allocation/i.test(m)) return 'Ran out of memory. Pick the Fast accuracy option or use a shorter clip.';
  return m;
}

/** Re-run the mapping and grouping after any change. Manual edits are kept. */
function reanalyze() {
  if (!state.project) return;
  analyze(state.project, state.settings);
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

let lastCapId = null;
function draw() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const p = state.project;
  const t = video.currentTime;
  if (p) {
    const cap = drawCaptions(octx, p, t, state.settings);
    const id = cap?.id || null;
    if (id !== lastCapId) {
      lastCapId = id;
      $$('.cap.now').forEach((el) => el.classList.remove('now'));
      if (id) {
        const el = document.querySelector(`.cap[data-id="${id}"]`);
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
  if (p) {
    p._byId = new Map(p.words.map((w) => [w.id, w]));
    strip.set(p, state.audio?.duration || video.duration || 1);
  }
  renderCaps();
  renderCast();
  renderCheck();
  renderStats();
  draw();
}

// ------------------------------------------------------------------ words tab
function speakerSelect(value, onChange, label) {
  const sel = document.createElement('select');
  sel.className = 'who';
  sel.setAttribute('aria-label', label);
  for (const s of state.project.cast) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    if (s.id === value) o.selected = true;
    sel.append(o);
  }
  const o = document.createElement('option');
  o.value = '__new';
  o.textContent = 'New speaker…';
  sel.append(o);
  const paint = () => sel.style.setProperty('--who', state.project.cast.find((s) => s.id === sel.value)?.color || 'var(--line)');
  paint();
  sel.onchange = () => {
    let id = sel.value;
    if (id === '__new') id = newSpeakerId();
    onChange(id);
  };
  return sel;
}
function newSpeakerId() {
  let n = 1;
  const ids = new Set(state.project.cast.map((s) => s.id));
  while (ids.has(`S${n}`)) n++;
  return `S${n}`;
}

function renderCaps() {
  const ol = $('#caps');
  ol.innerHTML = '';
  const p = state.project;
  if (!p) return;
  const byId = p._byId || new Map(p.words.map((w) => [w.id, w]));
  const colors = new Map(p.cast.map((s) => [s.id, s.color]));
  const frag = document.createDocumentFragment();
  for (const c of p.captions) {
    const li = document.createElement('li');
    li.className = 'cap';
    li.dataset.id = c.id;
    li.style.setProperty('--who', colors.get(c.speaker) || 'var(--line)');
    const time = document.createElement('time');
    time.textContent = clock(c.start);
    const body = document.createElement('div');
    body.className = 'chips';
    for (const id of c.wordIds) {
      const w = byId.get(id);
      const b = document.createElement('button');
      b.className = `chip${w.emphasis ? ' emph' : ''}${Object.keys(w.manual).length ? ' manual' : ''}${w.id === state.selected ? ' sel' : ''}`;
      b.style.fontWeight = w.weight;
      b.style.fontSize = `${(14 * (0.6 + 0.4 * w.size)).toFixed(1)}px`;
      b.textContent = w.text;
      b.dataset.word = w.id;
      b.onclick = () => selectWord(w.id);
      body.append(b);
    }
    body.append(speakerSelect(c.speaker, (id) => {
      for (const wid of c.wordIds) { const w = byId.get(wid); w.speaker = id; w.speakerManual = true; }
      reanalyze();
    }, 'Speaker for this caption'));
    li.append(time, body);
    frag.append(li);
  }
  ol.append(frag);
  lastCapId = null;
}

const selected = () => state.project?.words.find((w) => w.id === state.selected);

function selectWord(id) {
  const w = state.project?.words.find((x) => x.id === id);
  state.selected = w ? id : null;
  strip.selected = state.selected;
  $$('.chip.sel').forEach((c) => c.classList.remove('sel'));
  $('#inspector').hidden = !w;
  $('#wordsHelp').hidden = !!w;
  if (!w) return strip.draw();
  document.querySelector(`.chip[data-word="${id}"]`)?.classList.add('sel');
  syncInspector(w);
  if (video.paused) seek(w.start + 0.01);
  else strip.draw();
}
function syncInspector(w) {
  $('#wordText').value = w.text;
  $('#wordWeight').value = w.weight;
  $('#weightOut').textContent = w.weight;
  $('#wordSize').value = w.size;
  $('#sizeOut').textContent = `${w.size.toFixed(2)}×`;
  $('#wordEmphasis').checked = w.emphasis;
  $('#wordAuto').disabled = !Object.keys(w.manual).length;
  $('#wordText').style.fontWeight = w.weight;
}
function editWord(fn) {
  const w = selected();
  if (!w) return;
  fn(w);
  reanalyze();
  selectWord(w.id);
}

$('#wordText').addEventListener('change', (e) => { const t = e.target.value.trim(); if (t) editWord((w) => (w.text = t)); });
$('#wordWeight').addEventListener('input', (e) => {
  const w = selected(); if (!w) return;
  w.manual.weight = Number(e.target.value);
  w.weight = w.manual.weight;
  syncInspector(w); draw(); strip.draw();
});
$('#wordWeight').addEventListener('change', () => editWord(() => {}));
$('#wordSize').addEventListener('input', (e) => {
  const w = selected(); if (!w) return;
  w.manual.size = Number(e.target.value);
  w.size = w.manual.size;
  syncInspector(w); draw(); strip.draw();
});
$('#wordSize').addEventListener('change', () => editWord(() => {}));
$('#wordEmphasis').addEventListener('change', (e) => editWord((w) => (w.manual.emphasis = e.target.checked)));
$('#wordAuto').addEventListener('click', () => editWord((w) => (w.manual = {})));
$('#wordDelete').addEventListener('click', () => {
  const w = selected();
  if (!w) return;
  state.project.words = state.project.words.filter((x) => x !== w);
  selectWord(null);
  reanalyze();
});

// ------------------------------------------------------------------ speakers tab
function renderCast() {
  const ul = $('#cast');
  ul.innerHTML = '';
  const p = state.project;
  if (!p) return;
  for (const s of p.cast) {
    const li = document.createElement('li');
    li.className = 'speaker';
    li.style.setProperty('--who', s.color);
    const count = p.words.filter((w) => w.speaker === s.id).length;
    const name = document.createElement('input');
    name.type = 'text';
    name.value = s.name;
    name.setAttribute('aria-label', `Name for ${s.name}`);
    name.onchange = () => { s.name = name.value.trim() || s.name; refresh(); };
    const meta = document.createElement('small');
    const vp = s.voice_profile;
    meta.textContent = `${count} word${count === 1 ? '' : 's'}${vp ? `, usual pitch ${Math.round(vp.pitch_baseline_hz)} Hz` : ''}`;
    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    const used = new Set(p.cast.filter((x) => x !== s).map((x) => x.color.toLowerCase()));
    for (const c of SPEAKER_COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.title = used.has(c.toLowerCase()) ? `${c} (used by another speaker)` : c;
      b.setAttribute('aria-label', `Use color ${c}`);
      b.setAttribute('aria-pressed', String(c.toLowerCase() === s.color.toLowerCase()));
      b.disabled = used.has(c.toLowerCase());
      b.onclick = () => { s.color = c; refresh(); };
      swatches.append(b);
    }
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.value = s.color;
    custom.title = 'Pick any color';
    custom.setAttribute('aria-label', 'Pick any color');
    custom.oninput = () => { s.color = custom.value.toUpperCase(); draw(); };
    custom.onchange = () => {
      refresh();
      const r = contrastRatio(s.color, '#1a1a1a');
      if (r < 4.5) toast(`That color is hard to read on dark backgrounds (${r.toFixed(1)}:1, needs 4.5:1). Try a lighter shade.`, true, 7000);
    };
    swatches.append(custom);
    const head = document.createElement('div');
    head.className = 'speaker-head';
    head.append(name, meta);
    li.append(head, swatches);
    if (p.cast.length > 1) {
      const merge = document.createElement('select');
      merge.className = 'merge';
      merge.setAttribute('aria-label', `Merge ${s.name} into another speaker`);
      merge.innerHTML = `<option value="">Merge into…</option>` + p.cast.filter((x) => x !== s).map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
      merge.onchange = () => {
        if (!merge.value) return;
        for (const w of p.words) if (w.speaker === s.id) { w.speaker = merge.value; w.speakerManual = true; }
        reanalyze();
        toast(`Merged ${s.name} into ${p.cast.find((x) => x.id === merge.value)?.name}.`);
      };
      li.append(merge);
    }
    ul.append(li);
  }
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ check tab
function currentDoc() {
  return toCWIDocument(state.project, {
    title: state.file?.name?.replace(/\.[^.]+$/, ''),
    duration: state.audio?.duration || video.duration,
    language: state.language || 'und',
    backend: state.source,
  });
}
function renderCheck() {
  const p = state.project;
  const badge = $('#checkBadge');
  if (!p || !p.captions.length) { $('#score').innerHTML = ''; $('#rules').innerHTML = ''; badge.hidden = true; return; }
  const doc = currentDoc();
  const r = validate(doc);
  badge.hidden = false;
  badge.textContent = r.overall_score;
  badge.classList.toggle('fail', !r.passed);
  const pillar = (name, label) => {
    const x = r.pillars[name];
    return `<div class="pillar ${x.passed ? 'ok' : 'bad'}"><b>${x.score}</b><span>${label}</span></div>`;
  };
  $('#score').innerHTML = `<div class="overall ${r.passed ? 'ok' : 'bad'}"><b>${r.overall_score}</b><span>${r.passed ? 'Meets CWI' : 'Needs fixes'}</span></div>
    ${pillar('attribution', 'Speakers')}${pillar('synchronization', 'Timing')}${pillar('intonation', 'Intonation')}`;
  const capIdByDoc = new Map(doc.captions.map((c, i) => [c.id, p.captions[i]?.id]));
  $('#rules').innerHTML = RULE_LIST.map((rule) => {
    const found = r.rules[rule.id];
    const items = found.slice(0, 4).map((f) => {
      const cap = f.location?.caption_id ? capIdByDoc.get(f.location.caption_id) : null;
      return `<li>${cap ? `<button class="link" data-cap="${cap}">${escapeHtml(f.message)}</button>` : escapeHtml(f.message)}${f.suggestion ? ` <small>${escapeHtml(f.suggestion)}</small>` : ''}</li>`;
    }).join('');
    const more = found.length > 4 ? `<li><small>and ${found.length - 4} more</small></li>` : '';
    const sev = found[0]?.severity;
    return `<li class="rule ${found.length ? sev : 'pass'}"><span class="mark" aria-hidden="true"></span><span>${rule.label}<small>${rule.id}</small></span>${found.length ? `<ul>${items}${more}</ul>` : ''}</li>`;
  }).join('');
}
$('#rules').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cap]');
  if (!b) return;
  const c = state.project.captions.find((x) => x.id === b.dataset.cap);
  if (c) { seek(c.start + 0.01); showTab('words'); document.querySelector(`.cap[data-id="${c.id}"]`)?.scrollIntoView({ block: 'center' }); }
});

function renderStats() {
  const p = state.project;
  const el = $('#stats');
  if (!p || !p.words.length) { el.textContent = ''; return; }
  const bold = p.words.filter((w) => w.weight > CWI.WEIGHT_DEFAULT).length;
  const thin = p.words.filter((w) => w.weight < CWI.WEIGHT_DEFAULT).length;
  const emph = p.words.filter((w) => w.emphasis).length;
  el.textContent = `${p.words.length} words: ${bold} bolder, ${thin} thinner, ${emph} emphasized.`;
}

// ------------------------------------------------------------------ style tab
function setSeg(sel, value) {
  $$(`${sel} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
}
function buildPickers() {
  // Tiny subsets of every font, just enough to draw the "Aa" samples.
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = cssUrl(FONTS, 'Aa');
  document.head.append(link);
  $('#fonts').innerHTML = FONTS.map((f) => `
    <button class="font-card" role="radio" data-v="${f.id}" aria-checked="false">
      <span class="sample" style="font-family:${familyStack(f).replace(/"/g, "'")}">${f.fixed
        ? `<span class="hi" style="font-weight:${f.min}">Aa</span>`
        : `<span class="lo" style="font-weight:${f.min}">Aa</span><span class="hi" style="font-weight:${f.max}">Aa</span>`}</span>
      <b>${f.name}</b>
      <small>${f.hint}${f.fixed ? '. One weight, so pitch shows as thickness' : f.min >= 400 ? '. Can’t go thinner than regular' : ''}</small>
    </button>`).join('');
  $('#motions').innerHTML = Object.entries(MOTIONS).map(([id, m]) => `
    <button class="motion-card" role="radio" data-v="${id}" aria-checked="false">
      <span class="glyph" aria-hidden="true"><span>Aa</span></span>
      <b>${m.label}</b><small>${m.hint}</small>
    </button>`).join('');
}
$('#fonts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  state.settings.font = b.dataset.v;
  saveSettings(); syncSettings();
  ensureFont(getFont(b.dataset.v)).then(draw);
  draw();
});
$('#motions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  state.settings.motion = b.dataset.v;
  saveSettings(); syncSettings(); draw();
});

function syncSettings() {
  const s = state.settings;
  $$('#fonts [data-v]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === s.font)));
  $$('#motions [data-v]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === s.motion)));
  $('#motionNote').hidden = !s.motion || s.motion === 'flat';
  for (const k of ['position', 'layout', 'textSize', 'backing']) setSeg(`#${k}`, s[k]);
  $('#names').checked = !!s.names;
  $('#sensitivity').value = s.sensitivity;
}
for (const k of ['position', 'layout', 'textSize', 'backing']) {
  $(`#${k}`).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.settings[k] = b.dataset.v;
    saveSettings(); syncSettings();
    k === 'layout' ? reanalyze() : draw();
  });
}
$('#names').addEventListener('change', (e) => { state.settings.names = e.target.checked; saveSettings(); draw(); });
let sensTimer;
$('#sensitivity').addEventListener('input', (e) => {
  state.settings.sensitivity = Number(e.target.value);
  saveSettings();
  clearTimeout(sensTimer);
  sensTimer = setTimeout(reanalyze, 60);
});

function showTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((t) => (t.hidden = t.dataset.pane !== name));
}
$('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

// ------------------------------------------------------------------ files in
async function setSubs(file) {
  const text = await file.text();
  let kind = 'cues', n = 0;
  if (/\.json$/i.test(file.name) || text.trimStart().startsWith('{')) {
    try {
      const doc = JSON.parse(text);
      fromCWIDocument(doc);
      kind = 'cwi';
      n = doc.captions.length;
    } catch (e) {
      $('#subsName').textContent = `${file.name} is not a CWI file.`;
      return;
    }
  } else n = parseCues(text).length;
  if (!n) { $('#subsName').textContent = `${file.name} has no captions I can read.`; state.subs = null; return; }
  state.subs = { kind, text, name: file.name };
  $('#subsName').textContent = `${file.name}: ${n} captions. Now choose the video.`;
  if (state.file && state.audio && !state.busy) {
    // Video already open: swap in the imported captions.
    if (kind === 'cwi') {
      state.project = fromCWIDocument(JSON.parse(text));
      analyze(state.project, state.settings);
    } else {
      const words = wordsFromCues(parseCues(text));
      const feats = wordFeatures(words, state.audio.samples, state.audio.sampleRate);
      words.forEach((w, i) => (w.f = feats[i]));
      state.project = analyze({ words, cast: [] }, state.settings);
    }
    $('#exportBtn').disabled = false;
    refresh();
    toast(`Using ${n} captions from ${file.name}.`);
  }
}
$('#fileInput').addEventListener('change', (e) => openFile(e.target.files[0]));
$('#subsInput').addEventListener('change', (e) => e.target.files[0] && setSubs(e.target.files[0]));

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
document.addEventListener('drop', async (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  const subs = files.find((f) => /\.(srt|vtt|json)$/i.test(f.name));
  const media = files.find((f) => /^(video|audio)\//.test(f.type) || /\.(mp4|mov|webm|mkv|m4a|mp3|wav)$/i.test(f.name));
  if (subs) await setSubs(subs);
  if (media) openFile(media);
});

$('#newBtn').addEventListener('click', () => {
  if (state.busy) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  Object.assign(state, { file: null, audio: null, project: null, selected: null, subs: null, language: null });
  $('#subsName').textContent = '';
  $('#fileInput').value = '';
  $('#subsInput').value = '';
  $('#drop').hidden = false;
  $('#player').hidden = true;
  $('#newBtn').hidden = true;
  $('#fileName').hidden = true;
  $('#exportBtn').disabled = true;
  refresh();
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
menuList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]');
  if (!b || !state.project) return;
  menuList.hidden = true;
  const p = state.project;
  const kind = b.dataset.export;
  if (kind === 'srt') download(`${baseName()}.srt`, toSRT(p), 'application/x-subrip');
  if (kind === 'vtt') download(`${baseName()}.vtt`, toVTT(p), 'text/vtt');
  if (kind === 'cwi') download(`${baseName()}.cwi.json`, toCWIJSON(p, { title: baseName(), duration: state.audio?.duration || video.duration, language: state.language || 'und', backend: state.source }), 'application/json');
  if (kind === 'ass') download(`${baseName()}.ass`, toASS(p, { width: video.videoWidth || 1080, height: video.videoHeight || 1920, ...state.settings }), 'text/plain');
  if (kind === 'video') exportVideo();
});

async function exportVideo() {
  if (state.busy) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    toast('This browser cannot record video. Use Chrome or Edge, or export the .ass file and burn it in with ffmpeg.', true, 8000);
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
    await loadFonts();
    const p = state.project;
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
function loadFonts() {
  return ensureFont(getFont(state.settings.font));
}
buildPickers();
syncSettings();
loadFonts().then(draw);
document.fonts?.ready.then(draw);
window.addEventListener('beforeunload', (e) => { if (state.busy) e.preventDefault(); });

// Test hook for the browser tests.
window.__rc = { state, openFile, reanalyze, refresh };
