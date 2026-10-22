// The intention strip: one block per word under the video. Block height shows
// size (volume), opacity shows weight (pitch), color shows the speaker, and a
// dot marks emphasis. Click to seek or pick a word.

const CSS = getComputedStyle(document.documentElement);
const v = (name) => CSS.getPropertyValue(name).trim();

export class Strip {
  constructor(wrap, { onSeek, onPick }) {
    this.wrap = wrap;
    this.canvas = wrap.querySelector('canvas');
    this.spacer = document.createElement('div');
    this.spacer.style.height = '1px';
    wrap.appendChild(this.spacer);
    this.canvas.style.position = 'sticky';
    this.canvas.style.left = '0';
    this.ctx = this.canvas.getContext('2d');
    this.project = null;
    this.duration = 1;
    this.env = null;
    this.t = 0;
    this.selected = null;
    this.onSeek = onSeek;
    this.onPick = onPick;
    this.colors = { signal: v('--signal'), line: v('--line'), muted: v('--muted'), text: v('--text') };
    wrap.addEventListener('scroll', () => this.draw());
    // Don't fight someone swiping the timeline: pause auto-follow for a moment.
    this.userAt = 0;
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) wrap.addEventListener(ev, () => (this.userAt = performance.now()), { passive: true });
    new ResizeObserver(() => this.resize()).observe(wrap);
    wrap.addEventListener('click', (e) => this.click(e));
  }

  get pps() { return Math.max(8, Math.min(70, 30000 / this.duration)); }

  set(project, duration, env) {
    this.project = project;
    this.duration = Math.max(1, duration || 1);
    if (env) this.env = env;
    this.spacer.style.width = `${Math.ceil(this.duration * this.pps)}px`;
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight || 72;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.marginBottom = `-${h}px`;
    this.draw();
  }

  setTime(t, follow) {
    this.t = t;
    if (follow && performance.now() - this.userAt > 2500) {
      const x = t * this.pps, left = this.wrap.scrollLeft, w = this.wrap.clientWidth;
      if (x < left + 20 || x > left + w - 60) this.wrap.scrollLeft = Math.max(0, x - w * 0.3);
    }
    this.draw();
  }

  hit(x) {
    const t = x / this.pps;
    const w = this.project?.words.find((w) => t >= w.start - 0.03 && t <= w.end + 0.03);
    return { t, w };
  }

  click(e) {
    const r = this.wrap.getBoundingClientRect();
    const { t, w } = this.hit(e.clientX - r.left + this.wrap.scrollLeft);
    if (w) this.onPick?.(w.id);
    else this.onSeek?.(Math.max(0, Math.min(this.duration, t)));
  }

  draw() {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr, H = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pps = this.pps, left = this.wrap.scrollLeft;
    const t0 = left / pps, t1 = (left + W) / pps;
    const base = H - 6;

    if (this.env) {
      const step = 0.05;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      for (let i = Math.floor(t0 / step); i < Math.min(this.env.length, t1 / step); i++) {
        const h = Math.min(1, this.env[i] * 2.2) * (H - 14);
        ctx.fillRect(i * step * pps - left, base - h, Math.max(1, step * pps - 0.5), h);
      }
    }

    // Seconds ticks
    ctx.fillStyle = this.colors.muted;
    ctx.font = '10px system-ui, sans-serif';
    const every = pps < 15 ? 10 : pps < 30 ? 5 : 1;
    for (let s = Math.ceil(t0 / every) * every; s < t1; s += every) {
      ctx.globalAlpha = 0.5;
      ctx.fillRect(s * pps - left, H - 4, 1, 4);
      if (s % (every * 5) === 0) ctx.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, s * pps - left + 3, 10);
    }
    ctx.globalAlpha = 1;

    const p = this.project;
    if (p) {
      const byId = new Map(p.words.map((w) => [w.id, w]));
      const colors = new Map(p.cast.map((c) => [c.id, c.color]));
      for (const cap of p.captions) {
        if (cap.end < t0 || cap.start > t1) continue;
        const color = colors.get(cap.speaker) || this.colors.text;
        for (const id of cap.wordIds) {
          const w = byId.get(id);
          if (!w) continue;
          const x = w.start * pps - left;
          const bw = Math.max(2, (w.end - w.start) * pps - 1.5);
          const h = 8 + ((w.size - 0.7) / 0.8) * (H - 30);
          ctx.globalAlpha = 0.35 + 0.65 * ((w.weight - 100) / 800);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(x, base - h, bw, h, 2) : ctx.rect(x, base - h, bw, h);
          ctx.fill();
          ctx.globalAlpha = 1;
          if (w.emphasis) {
            ctx.beginPath();
            ctx.arc(x + bw / 2, base - h - 5, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
          if (w.id === this.selected) {
            ctx.strokeStyle = this.colors.signal;
            ctx.lineWidth = 2;
            ctx.strokeRect(x - 1, base - h - 1, bw + 2, h + 2);
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    const px = this.t * pps - left;
    ctx.fillStyle = this.colors.signal;
    ctx.fillRect(px - 1, 0, 2, H);
  }
}
