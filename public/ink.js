// Drifting calligraphic ribbons behind the app, after the line-art on the Wareef box.
// Each ribbon is a bundle of thin strokes whose width twists, so it folds like the logo's ribbon.

const RIBBONS = [
  { y: 0.26, amp: 0.15, freq: 1.5, speed: 0.045, width: 78, phase: 0.0, twist: 1.25, alpha: 0.11, lines: 18 },
  { y: 0.64, amp: 0.2, freq: 1.05, speed: -0.032, width: 120, phase: 2.1, twist: 0.85, alpha: 0.075, lines: 22 },
  { y: 0.9, amp: 0.1, freq: 2.1, speed: 0.055, width: 50, phase: 4.2, twist: 1.7, alpha: 0.085, lines: 13 },
];

export function startInk() {
  if (document.getElementById('ink')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'ink';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0;
  let H = 0;
  let mx = 0;
  let my = 0;
  let raf = 0;
  let last = 0;

  const resize = () => {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    W = innerWidth;
    H = innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (still) draw(8);
  };

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    const steps = W < 600 ? 50 : 90;
    for (const r of RIBBONS) {
      for (let i = 0; i < r.lines; i++) {
        const k = i / (r.lines - 1) - 0.5;
        ctx.beginPath();
        for (let s = 0; s <= steps; s++) {
          const u = s / steps;
          const x = -0.1 * W + u * 1.2 * W + mx * 24;
          const th = u * r.freq * Math.PI * 2 + t * r.speed * 6 + r.phase;
          const centre = H * (r.y + my * 0.025) + Math.sin(th) * r.amp * H + Math.sin(th * 0.5 + t * 0.2) * 28;
          const w = r.width * Math.cos(u * r.twist * Math.PI * 2 + t * r.speed * 4 + r.phase);
          const y = centre + k * w;
          if (s) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        const edge = 1 - Math.abs(k) * 1.4;
        ctx.strokeStyle = `rgba(255,255,255,${(r.alpha * (0.3 + Math.max(0, edge) * 0.7)).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 33) return; // ~30 fps is plenty for a slow drift
    last = now;
    draw(now / 1000);
  }

  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => { mx = e.clientX / W - 0.5; my = e.clientY / H - 0.5; }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (still) return;
    cancelAnimationFrame(raf);
    if (!document.hidden) raf = requestAnimationFrame(frame);
  });
  resize();
  if (!still) raf = requestAnimationFrame(frame);
}
