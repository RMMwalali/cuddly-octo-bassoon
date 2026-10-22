// Draws CWI captions for time `t` onto a 2D canvas. Used for the live preview
// and, frame by frame, for the burned-in video export.
//
// Per word: Roboto Flex at the word's weight, scaled by its size; white until
// spoken, then easing to the speaker's color over 600 ms; emphasized words
// bounce 15% upward over the same 600 ms.

import { CWI } from './cwi.js';
import { getFont, familyStack, fontWeight, fauxBold, DEFAULT_FONT } from './fonts.js';
import { draw3D, MOTIONS } from './gl3d.js';

export { MOTIONS };
export const FONT = '"Roboto Flex", "Roboto", system-ui, sans-serif';
export const POSITIONS = { top: 0.18, middle: 0.62, bottom: 0.84 };
export const TEXT_SIZES = { small: 0.05, medium: 0.062, large: 0.076 };
export const DEFAULT_SETTINGS = {
  position: 'bottom',
  layout: 'short',
  textSize: 'medium',
  backing: 'outline', // 'outline' | 'box'
  names: false,
  sensitivity: 1,
  font: DEFAULT_FONT,
  motion: 'pop', // see MOTIONS in gl3d.js
};

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const easeOutBack = (x) => { const c1 = 1.7, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; };

/** CSS `ease`, i.e. cubic-bezier(0.25, 0.1, 0.25, 1), solved for y at x. */
export function ease(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const bx = 0.75 * t * (1 - t) ** 2 + 0.75 * t * t * (1 - t) + t ** 3 - x;
    const d = 0.75 * (1 - t) ** 2 + 2.25 * t * t;
    t = clamp(t - bx / (d || 1));
  }
  return 0.3 * t * (1 - t) ** 2 + 3 * t * t * (1 - t) + t ** 3;
}

function hexRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16));
}
function mix(a, b, k) {
  const A = hexRgb(a), B = hexRgb(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`;
}

/** The caption on screen at time t (binary search; captions are sorted). */
export function captionAt(captions, t) {
  let lo = 0, hi = captions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = captions[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

/** Canvas font string for a word in the chosen typeface. */
export function fontFor(w, px, font) {
  return `${fontWeight(font, w.weight)} ${Math.round(px)}px ${familyStack(font)}`;
}
export const strokeFor = (w, px) => px * (0.07 + 0.08 * (w.weight / 900));

export function layoutCaption(ctx, cap, byId, W, H, settings) {
  const base = (settings.sizeRef ?? Math.min(W, H)) * (TEXT_SIZES[settings.textSize] || TEXT_SIZES.medium);
  const maxW = W * 0.86;
  const font = getFont(settings.font);
  // 3D words lift toward the camera and look bigger, so give them more room.
  const is3D = !!settings.motion && !MOTIONS[settings.motion]?.flat;
  const items = cap.wordIds.map((id) => byId.get(id)).filter(Boolean).map((w) => {
    const px = base * w.size;
    ctx.font = fontFor(w, px, font);
    // Bigger words get more room so the emphasis bounce never touches a neighbour.
    return { w, px, width: ctx.measureText(w.text).width, space: Math.max(base, px) * (is3D ? 0.42 : 0.3) + (w.emphasis ? px * (is3D ? 0.16 : 0.08) : 0) };
  });
  const lines = [];
  let line = { items: [], width: 0, h: 0 };
  for (const it of items) {
    const add = (line.items.length ? it.space : 0) + it.width;
    if (line.items.length && line.width + add > maxW) { lines.push(line); line = { items: [], width: 0, h: 0 }; }
    line.width += (line.items.length ? it.space : 0) + it.width;
    line.h = Math.max(line.h, it.px * 1.22);
    line.items.push(it);
  }
  if (line.items.length) lines.push(line);
  const total = lines.reduce((a, l) => a + l.h, 0);
  const cy = H * (POSITIONS[settings.position] ?? POSITIONS.bottom);
  let y = Math.max(base * 0.6, Math.min(cy - total / 2, H - total - base * 0.6));
  const top = y;
  for (const l of lines) {
    l.top = y;
    l.baseline = y + l.h * 0.8; // words of different sizes share one baseline
    y += l.h;
    let x = W / 2 - l.width / 2;
    for (const it of l.items) { it.x = x; it.y = l.baseline; x += it.width + it.space; }
  }
  return { lines, top, bottom: y, base, font };
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

/** Draw the captions at time t. `project` = { words, cast, captions }. Returns the caption drawn. */
export function drawCaptions(ctx, project, t, settings) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const byId = project._byId || new Map(project.words.map((w) => [w.id, w]));
  const cap = captionAt(project.captions, t);
  if (!cap) return null;
  const speaker = project.cast.find((s) => s.id === cap.speaker);
  const color = speaker?.color || '#FFFFFF';
  const L = layoutCaption(ctx, cap, byId, W, H, settings);
  const enter = clamp((t - cap.start) / 0.12);
  const anim = CWI.ANIMATION_MS / 1000;

  if (settings.motion && !MOTIONS[settings.motion]?.flat && draw3D(ctx, L, cap, color, t, settings, enter)) {
    if (settings.names && speaker) drawName(ctx, L, speaker.name, color, enter, W);
    return cap;
  }

  ctx.save();
  ctx.globalAlpha = enter;
  if (settings.backing === 'box') {
    ctx.fillStyle = 'rgba(26,26,26,0.86)';
    for (const l of L.lines) {
      const padX = L.base * 0.4, padY = L.base * 0.08;
      roundRect(ctx, W / 2 - l.width / 2 - padX, l.top - padY, l.width + padX * 2, l.h + padY * 2, L.base * 0.2);
      ctx.fill();
    }
  }
  if (settings.names && speaker) drawName(ctx, L, speaker.name, color, 1, W);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const pop = settings.motion === 'pop';
  // Pop: the caption slides up into place, and each word starts a little
  // smaller and dimmer, then springs up to full size as it's spoken.
  const rise = pop ? (1 - easeOutCubic(enter)) * L.base * 0.35 : 0;
  for (const l of L.lines) {
    for (const it of l.items) {
      const { w } = it;
      const k = t >= w.start ? ease((t - w.start) / anim) : 0;
      let scale = 1, dy = rise, alpha = 1;
      if (pop) {
        const q = t >= w.start ? clamp((t - w.start) / 0.28) : 0;
        scale = 0.92 + 0.08 * easeOutBack(q);
        dy += (1 - easeOutCubic(q)) * it.px * 0.12;
        alpha = 0.6 + 0.4 * clamp(q * 1.5);
      }
      if (w.emphasis && t >= w.start && t < w.start + anim) scale *= 1 + CWI.BOUNCE * Math.sin((Math.PI * (t - w.start)) / anim);
      ctx.save();
      ctx.globalAlpha *= alpha;
      // Scale from the word's bottom center so the bounce rises upward.
      ctx.translate(it.x + it.width / 2, it.y + dy);
      ctx.scale(scale, scale);
      ctx.font = fontFor(w, it.px, L.font);
      const faux = fauxBold(L.font, w.weight, it.px);
      if (settings.backing !== 'box') {
        // Thinner strokes on thin type so light weights stay legible, not hollow.
        ctx.lineWidth = strokeFor(w, it.px) + faux;
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = it.px * 0.15;
        ctx.shadowOffsetY = it.px * 0.04;
        ctx.strokeText(w.text, -it.width / 2, 0);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = k > 0 ? mix('#FFFFFF', color, k) : '#FFFFFF';
      if (faux) { ctx.lineWidth = faux; ctx.strokeStyle = ctx.fillStyle; ctx.strokeText(w.text, -it.width / 2, 0); }
      ctx.fillText(w.text, -it.width / 2, 0);
      ctx.restore();
    }
  }
  ctx.restore();
  return cap;
}

function drawName(ctx, L, name, color, alpha, W) {
  const px = L.base * 0.5;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `600 ${Math.round(px)}px ${familyStack(L.font)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const y = L.top - px * 0.45;
  ctx.lineWidth = px * 0.25;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(name, W / 2, y);
  ctx.fillStyle = color;
  ctx.fillText(name, W / 2, y);
  ctx.restore();
}

export { mix, ease as cssEase };
