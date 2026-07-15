// Decorative particle field — a lightweight canvas-2D echo of the main
// site's WebGL particle background (assets/graph.js on jpfinnie/website).
// Purely cosmetic: pointer-events none, honors prefers-reduced-motion,
// pauses when the tab is hidden.

(() => {
  const canvas = document.getElementById("field");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const COUNT = 70;
  const LINK_DIST = 130;
  let w = 0, h = 0, dpr = 1;
  let particles = [];
  let raf = 0;
  const mouse = { x: -1e4, y: -1e4 };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    particles = Array.from({ length: COUNT }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: 0.8 + Math.random() * 1.6,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(217, 169, 78, 0.32)";
      ctx.fill();
    }
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i], b = particles[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LINK_DIST * LINK_DIST) {
          const alpha = 0.09 * (1 - Math.sqrt(d2) / LINK_DIST);
          ctx.strokeStyle = `rgba(148, 163, 190, ${alpha.toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
  }

  function tick() {
    for (const p of particles) {
      // Gentle drift plus a soft push away from the pointer.
      const dx = p.x - mouse.x, dy = p.y - mouse.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 16000) {
        p.vx += (dx / Math.sqrt(d2 + 1)) * 0.02;
        p.vy += (dy / Math.sqrt(d2 + 1)) * 0.02;
      }
      p.vx = Math.max(-0.4, Math.min(0.4, p.vx));
      p.vy = Math.max(-0.4, Math.min(0.4, p.vy));
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10;
      if (p.y > h + 10) p.y = -10;
    }
    draw();
    raf = requestAnimationFrame(tick);
  }

  window.addEventListener("resize", () => {
    resize();
    seed();
    if (reduced) draw();
  });
  window.addEventListener("pointermove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });
  document.addEventListener("visibilitychange", () => {
    if (reduced) return;
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      raf = requestAnimationFrame(tick);
    }
  });

  resize();
  seed();
  if (reduced) draw();
  else raf = requestAnimationFrame(tick);
})();
