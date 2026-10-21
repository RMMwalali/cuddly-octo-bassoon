// Draws reactive captions for time `t` onto a 2D canvas context.
// Used for the live preview and, frame by frame, for the burned-in export.

import { PRESETS, POSITIONS, MOOD_COLORS, emphasisColor } from './presets.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; };
const easeOutCubic = (x) => 1 - (1 - x) ** 3;

/** Find the page on screen at time t (binary search; pages are sorted). */
export function pageAt(pages, t) {
  let lo = 0, hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid];
    if (t < p.start) hi = mid - 1;
    else if (t >= p.end) lo = mid + 1;
    else return p;
  }
  return null;
}

function wordText(w, preset, reactSize) {
  const upper = preset.upper || (reactSize && w.level === 3);
  return upper ? w.text.toUpperCase() : w.text;
}

function fontFor(preset, px, w, reactSize) {
  const weight = preset.emphasisWeight && reactSize && w.level >= 2 ? preset.emphasisWeight : preset.weight;
  return `${weight} ${Math.round(px)}px ${preset.font}`;
}

/** Lay out a page's words into centered lines. */
export function layoutPage(ctx, page, byId, W, H, settings) {
  const preset = PRESETS[settings.preset] || PRESETS.pop;
  const R = settings.react;
  const base = (settings.sizeRef ?? Math.min(W, H)) * preset.size * (page.mood === 'soft' && R.motion ? 0.94 : 1);
  const maxW = W * 0.86;
  const items = page.wordIds.map((id) => byId.get(id)).filter(Boolean).map((w) => {
    const px = base * (R.size ? preset.scales[w.level] || 1 : 1);
    const text = wordText(w, preset, R.size);
    ctx.font = fontFor(preset, px, w, R.size);
    // Extra gap leaves room for the active-word bump and shout scale.
    return { w, text, px, width: ctx.measureText(text).width, space: ctx.measureText(' ').width + px * 0.1 };
  });
  const lines = [];
  let line = { items: [], width: 0, h: 0 };
  for (const it of items) {
    const add = (line.items.length ? it.space : 0) + it.width;
    if (line.items.length && line.width + add > maxW) {
      lines.push(line);
      line = { items: [], width: 0, h: 0 };
    }
    line.width += (line.items.length ? it.space : 0) + it.width;
    line.h = Math.max(line.h, it.px * 1.18);
    line.items.push(it);
  }
  if (line.items.length) lines.push(line);
  const total = lines.reduce((a, l) => a + l.h, 0);
  const cy = H * (POSITIONS[settings.position] ?? POSITIONS.middle);
  let y = cy - total / 2;
  for (const l of lines) {
    l.y = y + l.h / 2;
    y += l.h;
    let x = W / 2 - l.width / 2;
    for (const it of l.items) {
      it.x = x + it.width / 2;
      it.y = l.y;
      x += it.width + it.space;
    }
  }
  return { lines, top: cy - total / 2, bottom: cy + total / 2, base, preset };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawWord(ctx, it, preset, color, { scale = 1, alpha = 1, dx = 0, dy = 0, rot = 0, sweep = null, R }) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(it.x + dx, it.y + dy);
  if (rot) ctx.rotate(rot);
  ctx.scale(scale, scale);
  ctx.font = fontFor(preset, it.px, it.w, R.size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (preset.strokeW > 0) {
    ctx.lineWidth = it.px * preset.strokeW;
    ctx.strokeStyle = preset.stroke;
    if (preset.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = it.px * 0.18;
      ctx.shadowOffsetY = it.px * 0.06;
    }
    ctx.strokeText(it.text, 0, 0);
    ctx.shadowColor = 'transparent';
  }
  ctx.fillStyle = color;
  ctx.fillText(it.text, 0, 0);
  if (sweep && sweep.p > 0) {
    // Karaoke: repaint the spoken part of the word in the bright color.
    ctx.beginPath();
    ctx.rect(-it.width / 2 - it.px, -it.px, it.width * sweep.p + it.px, it.px * 2);
    ctx.clip();
    ctx.fillStyle = sweep.color;
    ctx.fillText(it.text, 0, 0);
  }
  ctx.restore();
}

/**
 * Draw all captions for time t. `project` = { words, pages, sounds }.
 * Returns the page that was drawn (handy for UI sync).
 */
export function drawCaptions(ctx, project, t, settings) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const R = settings.react;
  const byId = project._byId || new Map(project.words.map((w) => [w.id, w]));
  const page = pageAt(project.pages, t);
  let top = H * (POSITIONS[settings.position] ?? POSITIONS.middle);

  if (page) {
    const L = layoutPage(ctx, page, byId, W, H, settings);
    const { preset } = L;
    top = L.top;
    const mood = page.mood;
    const emph = emphasisColor(preset, mood, R.color);
    const enter = clamp((t - page.start) / 0.12);

    if (preset.box) {
      ctx.save();
      ctx.globalAlpha = 0.62 * enter;
      ctx.fillStyle = '#000';
      for (const l of L.lines) {
        const padX = L.base * 0.45, padY = L.base * 0.12;
        roundRect(ctx, W / 2 - l.width / 2 - padX, l.y - l.h / 2 - padY / 2, l.width + padX * 2, l.h + padY, L.base * 0.25);
        ctx.fill();
      }
      ctx.restore();
    }

    const all = L.lines.flatMap((l) => l.items);
    all.forEach((it, i) => {
      const w = it.w;
      const next = all[i + 1]?.w;
      const activeEnd = next ? Math.max(w.end, next.start) : page.end;
      const spoken = t >= w.start;
      const active = spoken && t < activeEnd;
      const k = clamp((t - w.start) / 0.2);
      let scale = 1, alpha = 1, dx = 0, dy = 0, rot = 0, color = preset.fill, sweep = null;

      if (preset.reveal === 'word') {
        if (!spoken) return;
        scale = 0.55 + 0.45 * easeOutBack(clamp((t - w.start) / 0.16));
        alpha = clamp((t - w.start) / 0.06);
        color = w.level >= 2 && R.color ? emph : preset.fill;
      } else {
        scale = 0.9 + 0.1 * easeOutCubic(enter);
        alpha = enter;
        if (preset.reveal === 'sweep') {
          sweep = {
            p: spoken ? clamp((t - w.start) / Math.max(0.05, w.end - w.start)) : 0,
            color: w.level >= 2 && R.color ? emph : preset.accent,
          };
        } else if (active) {
          color = w.level >= 2 && R.color ? emph : preset.accent;
        } else if (w.level >= 2 && R.color) {
          color = emph;
        }
        if (active && preset.bump && R.motion) scale *= 1 + preset.bump * Math.sin(Math.PI * k);
        if (preset.box && w.level >= 1 && R.color && MOOD_COLORS[mood]) color = MOOD_COLORS[mood];
      }

      if (R.motion && active) {
        if (w.level === 3) {
          // Shout: brief shake on landing.
          const decay = 1 - clamp((t - w.start) / 0.35);
          dx = Math.sin(t * 95) * it.px * 0.05 * decay;
          dy = Math.cos(t * 83) * it.px * 0.04 * decay;
        }
        if (mood === 'excited' && preset.reveal !== 'sweep') dy -= Math.sin(Math.PI * k) * it.px * 0.12;
        if (mood === 'angry' && w.level >= 2) dx += Math.sin(t * 70) * it.px * 0.025;
        if (mood === 'question' && w === all[all.length - 1].w) rot = 0.06 * Math.sin(Math.PI * k);
      }
      drawWord(ctx, it, preset, color, { scale, alpha, dx, dy, rot, sweep, R });
    });
  }

  if (R.sounds && project.sounds?.length) {
    const live = project.sounds.filter((s) => t >= s.start && t < s.end);
    if (live.length) drawSoundTags(ctx, live, t, top, W, H, settings);
  }
  return page;
}

function drawSoundTags(ctx, sounds, t, top, W, H, settings) {
  const preset = PRESETS[settings.preset] || PRESETS.pop;
  const px = Math.min(W, H) * 0.032;
  ctx.save();
  ctx.font = `700 ${Math.round(px)}px ${preset.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labels = sounds.map((s) => `[${s.text}]`);
  const widths = labels.map((l) => ctx.measureText(l).width + px * 1.4);
  const gap = px * 0.5;
  let x = W / 2 - (widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1)) / 2;
  const y = Math.max(px * 1.5, top - px * 1.6);
  sounds.forEach((s, i) => {
    const a = clamp((t - s.start) / 0.15) * clamp((s.end - t) / 0.2);
    const pop = 0.7 + 0.3 * easeOutBack(clamp((t - s.start) / 0.2));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(x + widths[i] / 2, y);
    ctx.scale(pop, pop);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    roundRect(ctx, -widths[i] / 2, -px * 0.85, widths[i], px * 1.7, px * 0.85);
    ctx.fill();
    ctx.fillStyle = '#FFD23F';
    ctx.fillText(labels[i], 0, px * 0.04);
    ctx.restore();
    x += widths[i] + gap;
  });
  ctx.restore();
}
