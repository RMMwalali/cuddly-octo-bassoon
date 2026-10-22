// 3D caption styles, drawn with WebGL and composited onto the 2D caption canvas.
//
// Each word is rendered once as a glyph mask with the chosen font and weight,
// then drawn as textured quads in perspective: a stack of darker slices for
// extruded depth, an outline, the lit front face and a soft shadow. CWI still
// drives everything: the front face eases from white to the speaker's color as
// the word is spoken, size follows volume, weight follows pitch, and emphasized
// words bounce 15% (and, in 3D, also push toward the camera).

import { CWI } from './cwi.js';
import { getFont, familyStack, fontWeight, fauxBold } from './fonts.js';

export const MOTIONS = {
  flat: { label: 'Flat', hint: 'Classic CWI' },
  extrude: { label: 'Extrude', hint: 'Solid 3D letters' },
  flip: { label: 'Flip', hint: 'Words flip up as they are said' },
  swing: { label: 'Swing', hint: 'Words swing open like doors' },
  drop: { label: 'Drop', hint: 'Words fall into place' },
  stage: { label: 'Stage', hint: 'Caption on a tilted stage' },
};

const DEG = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const easeOutBack = (x) => { const c1 = 1.6, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; };
function cssEase(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const bx = 0.75 * t * (1 - t) ** 2 + 0.75 * t * t * (1 - t) + t ** 3 - x;
    t = clamp(t - bx / (0.75 * (1 - t) ** 2 + 2.25 * t * t || 1));
  }
  return 0.3 * t * (1 - t) ** 2 + 3 * t * t * (1 - t) + t ** 3;
}
const rgb = (hex) => { const h = hex.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255); };
const mixRGB = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

// ------------------------------------------------------------------ mat4 (column-major)
const I = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
const T = (x, y, z = 0) => { const m = I(); m[12] = x; m[13] = y; m[14] = z; return m; };
const S = (s) => { const m = I(); m[0] = m[5] = m[10] = s; return m; };
const RX = (a) => { const m = I(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; };
const RY = (a) => { const m = I(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; };
const around = (x, y, z, m) => mul(T(x, y, z), mul(m, T(-x, -y, -z)));
const apply = (m, v, w = 1) => [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * w);

/**
 * Projection that maps the z = 0 plane 1:1 onto canvas pixels, with y down
 * and +z toward the viewer.
 */
function viewProjection(W, H, fov = 32 * DEG) {
  const f = 1 / Math.tan(fov / 2);
  const d = (H / 2) * f;
  const near = d * 0.1, far = d * 10;
  const P = new Float32Array([f / (W / H), 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
  const V = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, -W / 2, H / 2, -d, 1]);
  return mul(P, V);
}

// ------------------------------------------------------------------ GL setup
const VS = `#version 300 es
in vec2 a_pos;
uniform mat4 u_mvp;
uniform vec4 u_rect;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = u_mvp * vec4(u_rect.xy + a_pos * u_rect.zw, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_color;
out vec4 o;
void main() {
  float a = texture(u_tex, v_uv).a * u_color.a;
  o = vec4(u_color.rgb * a, a);
}`;

let G = null; // false once WebGL is known to be unavailable

function init(W, H) {
  if (G === false) return null;
  if (!G) {
    if (typeof document === 'undefined') { G = false; return null; }
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) { G = false; return null; }
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { G = false; return null; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    canvas.addEventListener('webglcontextlost', () => { G = null; });
    G = {
      canvas, gl,
      u: { mvp: gl.getUniformLocation(prog, 'u_mvp'), rect: gl.getUniformLocation(prog, 'u_rect'), color: gl.getUniformLocation(prog, 'u_color') },
      cache: new Map(),
      scratch: document.createElement('canvas'),
    };
  }
  if (G.canvas.width !== W || G.canvas.height !== H) {
    G.canvas.width = W;
    G.canvas.height = H;
    G.vp = viewProjection(W, H);
  }
  G.gl.viewport(0, 0, W, H);
  return G;
}

/** Glyph mask texture: 'fill' (the letters), 'sil' (letters + outline), 'blur' (soft shadow). */
function mask(text, font, w, px, kind) {
  const fw = fontWeight(font, w.weight);
  const faux = fauxBold(font, w.weight, px);
  const stroke = px * (0.07 + 0.08 * (w.weight / 900)) + faux;
  const key = `${kind}|${text}|${font.id}|${fw}|${Math.round(px * 2) / 2}|${Math.round(faux)}`;
  const hit = G.cache.get(key);
  if (hit) { G.cache.delete(key); G.cache.set(key, hit); return hit; }

  const c = G.scratch;
  const ctx = c.getContext('2d');
  const css = `${fw} ${Math.round(px)}px ${familyStack(font)}`;
  ctx.font = css;
  const width = ctx.measureText(text).width;
  const pad = Math.ceil(stroke + (kind === 'blur' ? px * 0.3 : px * 0.08));
  const asc = px * 1.05, desc = px * 0.4;
  c.width = Math.ceil(width + pad * 2);
  c.height = Math.ceil(asc + desc + pad * 2);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = css;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  const ox = pad, oy = pad + asc;
  // Canvas filters are missing on older iOS Safari; fall back to a few soft offset copies.
  const canFilter = 'filter' in ctx && (ctx.filter = 'blur(1px)', ctx.filter === 'blur(1px)');
  ctx.filter = 'none';
  if (kind === 'blur' && canFilter) ctx.filter = `blur(${Math.max(1, px * 0.08)}px)`;
  if (kind === 'blur' && !canFilter) {
    const r = Math.max(1, px * 0.06);
    ctx.globalAlpha = 0.2;
    for (const [dx, dy] of [[-r, 0], [r, 0], [0, -r], [0, r], [0, 0]]) { ctx.lineWidth = stroke; ctx.strokeText(text, ox + dx, oy + dy); ctx.fillText(text, ox + dx, oy + dy); }
    ctx.globalAlpha = 1;
  } else {
    if (kind !== 'fill' || faux) {
      ctx.lineWidth = kind === 'fill' ? faux : stroke;
      ctx.strokeText(text, ox, oy);
    }
    ctx.fillText(text, ox, oy);
  }
  ctx.filter = 'none';

  const gl = G.gl;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const m = { tex, w: c.width, h: c.height, ox, oy };
  G.cache.set(key, m);
  while (G.cache.size > 150) {
    const [k0, v0] = G.cache.entries().next().value;
    gl.deleteTexture(v0.tex);
    G.cache.delete(k0);
  }
  return m;
}

function boxMask(w, h, r) {
  const key = `box|${Math.round(w)}|${Math.round(h)}|${Math.round(r)}`;
  if (G.cache.has(key)) return G.cache.get(key);
  const c = G.scratch;
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(0, 0, w, h, r) : ctx.rect(0, 0, w, h);
  ctx.fill();
  const gl = G.gl;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const m = { tex, w: c.width, h: c.height, ox: 0, oy: 0 };
  G.cache.set(key, m);
  return m;
}

function quad(m, model, x, y, color, alpha) {
  const gl = G.gl;
  gl.uniformMatrix4fv(G.u.mvp, false, mul(G.vp, model));
  gl.uniform4f(G.u.rect, x - m.ox, y - m.oy, m.w, m.h);
  gl.uniform4f(G.u.color, color[0], color[1], color[2], alpha);
  gl.bindTexture(gl.TEXTURE_2D, m.tex);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

const LIGHT = (() => { const v = [-0.35, -0.55, 0.76]; const n = Math.hypot(...v); return v.map((x) => x / n); })();

/** Free GPU textures (call after an export). */
export function clear3DCache() {
  if (!G || !G.cache) return;
  for (const m of G.cache.values()) G.gl.deleteTexture(m.tex);
  G.cache.clear();
}

/**
 * Draw caption `cap` (already laid out as `L` by layoutCaption) in 3D onto ctx.
 * Returns false when WebGL isn't available, so the caller falls back to 2D.
 */
export function draw3D(ctx, L, cap, speakerColor, t, settings, enter) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  let g;
  try { g = init(W, H); } catch (e) { console.warn('3D captions unavailable', e); G = false; return false; }
  if (!g) return false;
  const gl = g.gl;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const motion = settings.motion;
  const font = L.font || getFont(settings.font);
  const anim = CWI.ANIMATION_MS / 1000;
  const color = rgb(speakerColor);
  const white = [1, 1, 1];
  const sideUnspoken = [0.55, 0.55, 0.62];
  const sideSpoken = color.map((v) => v * 0.62);
  const cx = W / 2, cy = (L.top + L.bottom) / 2;
  const outline = settings.backing !== 'box';

  // Whole-caption pose.
  let global = I();
  if (motion === 'stage') global = around(cx, L.bottom, 0, RX(34 * DEG));
  else if (motion === 'extrude') global = around(cx, cy, 0, mul(RX(16 * DEG), RY(-8 * DEG)));
  // Caption entrance: rise slightly out of the screen.
  global = mul(T(0, (1 - enter) * L.base * 0.3, 0), global);

  if (settings.backing === 'box') {
    for (const l of L.lines) {
      const padX = L.base * 0.4, padY = L.base * 0.08;
      const bw = l.width + padX * 2, bh = l.h + padY * 2;
      const bm = boxMask(bw, bh, L.base * 0.2);
      quad(bm, mul(global, T(0, 0, -L.base * 0.3)), W / 2 - bw / 2, l.top - padY, [0.1, 0.1, 0.1], 0.86 * enter);
    }
  }

  const draws = [];
  for (const l of L.lines) {
    for (const it of l.items) {
      const w = it.w, px = it.px;
      const spoken = t >= w.start;
      const p = clamp((t - w.start) / anim);
      const k = spoken ? cssEase(p) : 0;
      const q = spoken ? easeOutBack(clamp((t - w.start) / 0.42)) : 0;
      const ax = it.x + it.width / 2, ay = it.y - px * 0.35;
      let local = I(), lift = 0, alpha = 1;

      if (motion === 'flip') local = around(ax, it.y, 0, RX(lerp(58, 0, q) * DEG));
      else if (motion === 'swing') local = around(it.x, ay, 0, RY(lerp(-52, 0, q) * DEG));
      else if (motion === 'drop') {
        local = mul(T(0, lerp(-px * 0.9, 0, q), lerp(px * 1.2, 0, clamp(q))), around(ax, ay, 0, RX(lerp(-25, 0, q) * DEG)));
        alpha = spoken ? clamp(0.35 + q) : 0.35;
      } else if (motion === 'stage') {
        // Spoken words stand up from the stage to face the viewer.
        local = around(ax, it.y, 0, RX(lerp(0, -34, clamp(q)) * DEG));
        lift = lerp(0, px * 0.15, clamp(q));
      }
      if (spoken && p < 1) lift += Math.sin(Math.PI * p) * px * (w.emphasis ? 0.55 : 0.16);

      // CWI emphasis: 15% bounce from the baseline.
      let bounce = I();
      if (w.emphasis && spoken && p < 1) bounce = around(ax, it.y, 0, S(1 + CWI.BOUNCE * Math.sin(Math.PI * p)));

      const model = mul(global, mul(T(0, 0, lift), mul(local, bounce)));
      const normal = apply(model, [0, 0, 1], 0);
      const nl = Math.hypot(...normal) || 1;
      const light = Math.max(0, (normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]) / nl);
      const depthZ = apply(model, [ax, ay, 0])[2];
      draws.push({ it, w, px, k, model, light, depthZ, alpha });
    }
  }
  draws.sort((a, b) => a.depthZ - b.depthZ);

  for (const d of draws) {
    const { it, w, px, k, model, light } = d;
    const a = d.alpha * enter;
    const fill = mask(w.text, font, w, px, 'fill');
    const sil = mask(w.text, font, w, px, 'sil');
    // Depth runs back into the screen and slightly down-right, the classic
    // extruded-title look that still reads when the word faces the camera.
    const depth = px * (motion === 'extrude' ? 0.22 : motion === 'stage' ? 0.2 : 0.16);
    const ox = depth * 0.35, oy = depth * 0.75;
    const slices = Math.max(8, Math.min(32, Math.round(Math.hypot(depth, oy) / Math.max(0.75, px * 0.008))));

    // Soft shadow behind the letters.
    const blur = mask(w.text, font, w, px, 'blur');
    quad(blur, mul(model, T(ox + px * 0.05, oy + px * 0.1, -depth - 1)), it.x, it.y, [0, 0, 0], 0.5 * a);

    // Extruded sides: slices from back to front, darker further back.
    const side = mixRGB(sideUnspoken, sideSpoken, k);
    for (let i = slices; i >= 1; i--) {
      const f = i / slices;
      const shade = (1 - 0.6 * f) * (0.7 + 0.3 * light);
      quad(outline ? sil : fill, mul(model, T(ox * f, oy * f, -depth * f)), it.x, it.y, side.map((v) => v * shade), a);
    }
    // Outline just behind the face, then the lit face itself.
    if (outline) quad(sil, mul(model, T(0, 0, -0.5)), it.x, it.y, [0, 0, 0], 0.9 * a);
    const face = mixRGB(white, color, k).map((v) => Math.min(1, v * (0.86 + 0.18 * light)));
    quad(fill, model, it.x, it.y, face, a);
  }

  gl.flush();
  ctx.drawImage(g.canvas, 0, 0);
  return true;
}
