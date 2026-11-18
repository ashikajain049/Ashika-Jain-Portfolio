import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

export interface StarFieldProps {
  /** 0–100. Number of stars scales with this and the canvas area. */
  density?: number;
  /** Multiplier for twinkle speed. */
  twinkleSpeed?: number;
  /** Multiplier for how often shooting stars appear (0 disables). */
  shootingStarRate?: number;
  /** "single" uses `hue` only; "dual" blends `hue` and `secondHue`. */
  color?: "single" | "dual";
  hue?: number;
  secondHue?: number;
  className?: string;
  style?: CSSProperties;
}

interface Star {
  x: number; y: number;      // normalised 0–1
  depth: number;             // 0 (far) – 1 (near)
  size: number;
  base: number;              // base alpha
  phase: number;
  speed: number;
  hue: number;
  sparkle: boolean;
}

interface Blob {
  x: number; y: number;      // normalised centre
  r: number;                 // normalised radius (of min side)
  ax: number; ay: number;    // drift amplitude
  px: number; py: number;    // drift phase
  sp: number;                // drift speed
  hue: number;
  alpha: number;
}

interface Ripple { x: number; y: number; age: number; life: number; power: number; }

const TRAIL = 18;
interface Shooter {
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; hue: number;
  tx: Float32Array; ty: Float32Array; head: number; count: number;
}

const MAX_RIPPLES = 12;
const MAX_SHOOTERS = 4;
const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export default function StarField({
  density = 70,
  twinkleSpeed = 1,
  shootingStarRate = 1,
  color = "single",
  hue = 220,
  secondHue = 290,
  className,
  style,
}: StarFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Live settings are read from a ref so changing them never restarts the loop.
  const cfg = useRef({ density, twinkleSpeed, shootingStarRate, color, hue, secondHue });
  cfg.current = { density, twinkleSpeed, shootingStarRate, color, hue, secondHue };

  const rebuild = useRef<(() => void) | null>(null);
  useEffect(() => { rebuild.current?.(); }, [density, color, hue, secondHue]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0, H = 0, dpr = 1;
    let stars: Star[] = [];
    let blobs: Blob[] = [];
    const ripples: Ripple[] = [];            // pooled: swap-remove on death
    const shooters: Shooter[] = Array.from({ length: MAX_SHOOTERS }, () => ({
      x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0, hue: 0,
      tx: new Float32Array(TRAIL), ty: new Float32Array(TRAIL), head: 0, count: 0,
    }));
    let liveShooters = 0;
    let nextShot = rand(1, 3);

    const pickHue = () => {
      const { color, hue, secondHue } = cfg.current;
      if (color === "single") return hue + rand(-12, 12);
      return Math.random() < 0.5 ? hue + rand(-12, 12) : secondHue + rand(-12, 12);
    };

    const build = () => {
      const { density } = cfg.current;
      const count = Math.round((Math.max(0, density) / 100) * (W * H) / 3200);
      stars = Array.from({ length: count }, () => {
        const depth = Math.pow(Math.random(), 1.6);
        return {
          x: Math.random(), y: Math.random(), depth,
          size: 0.4 + depth * 1.5,
          base: 0.25 + depth * 0.75,
          phase: rand(0, TAU),
          speed: rand(0.4, 1.6),
          hue: pickHue(),
          sparkle: depth > 0.8 && Math.random() < 0.6,
        };
      });
      const { color, hue, secondHue } = cfg.current;
      const h2 = color === "single" ? hue + 20 : secondHue;
      blobs = [
        { x: 0.25, y: 0.3, r: 0.55, ax: 0.08, ay: 0.06, px: 0, py: 1, sp: 0.05, hue, alpha: 0.12 },
        { x: 0.75, y: 0.65, r: 0.6, ax: 0.07, ay: 0.09, px: 2, py: 3, sp: 0.04, hue: h2, alpha: 0.1 },
        { x: 0.5, y: 0.9, r: 0.45, ax: 0.1, ay: 0.04, px: 4, py: 5, sp: 0.06, hue, alpha: 0.07 },
      ];
    };
    rebuild.current = build;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, rect.width); H = Math.max(1, rect.height);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    };

    /* ---------- pointer ripples ---------- */
    let lastRx = -1e9, lastRy = -1e9;
    const spawnRipple = (x: number, y: number, power: number) => {
      if (ripples.length >= MAX_RIPPLES) ripples.shift();
      ripples.push({ x, y, age: 0, life: 2.4, power });
    };
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      if (Math.hypot(x - lastRx, y - lastRy) > 90) {
        lastRx = x; lastRy = y;
        spawnRipple(x, y, 0.6);
      }
    };
    const onDown = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      spawnRipple(e.clientX - r.left, e.clientY - r.top, 1);
    };

    /* ---------- shooting stars ---------- */
    const spawnShooter = () => {
      if (liveShooters >= MAX_SHOOTERS) return;
      const s = shooters[liveShooters++];
      const ang = rand(0.4, 0.85);
      const speed = rand(0.5, 0.9) * Math.max(W, 400);
      s.x = rand(-0.05, 0.8) * W; s.y = rand(0, 0.45) * H;
      s.vx = Math.cos(ang) * speed; s.vy = Math.sin(ang) * speed;
      s.age = 0; s.life = rand(0.8, 1.4); s.head = 0; s.count = 0;
      s.hue = pickHue();
    };

    /* ---------- frame ---------- */
    const drawNebulae = (t: number) => {
      const m = Math.min(W, H);
      for (const b of blobs) {
        const cx = (b.x + Math.sin(t * b.sp + b.px) * b.ax) * W;
        const cy = (b.y + Math.cos(t * b.sp + b.py) * b.ay) * H;
        const rad = b.r * Math.max(m, W * 0.5);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        g.addColorStop(0, `hsla(${b.hue},70%,45%,${b.alpha})`);
        g.addColorStop(0.6, `hsla(${b.hue},65%,35%,${b.alpha * 0.4})`);
        g.addColorStop(1, `hsla(${b.hue},60%,30%,0)`);
        ctx.fillStyle = g;
        ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      }
    };

    const drawStars = (t: number) => {
      const tw = cfg.current.twinkleSpeed;
      for (const s of stars) {
        let x = s.x * W + Math.sin(t * 0.03 + s.phase) * 3 * s.depth;
        let y = s.y * H + Math.cos(t * 0.025 + s.phase) * 3 * s.depth;
        let boost = 0;
        // ripples push stars outward in a travelling wave and brighten the crest
        for (let i = 0; i < ripples.length; i++) {
          const r = ripples[i];
          const radius = r.age * 260;
          const dx = x - r.x, dy = y - r.y;
          const d = Math.hypot(dx, dy) || 1;
          const off = d - radius;
          if (off > -60 && off < 60) {
            const fall = 1 - r.age / r.life;
            const k = Math.exp(-(off * off) / 1400) * fall * r.power;
            const push = k * 9 * (0.4 + s.depth);
            x += (dx / d) * push; y += (dy / d) * push;
            boost += k;
          }
        }
        const tws = 0.5 + 0.5 * Math.sin(t * s.speed * tw * 2 + s.phase);
        const a = Math.min(1, s.base * (0.25 + 0.75 * tws) + boost * 0.5);
        if (a < 0.02) continue;
        const sat = s.depth > 0.5 ? 55 : 35;
        const rad = s.size * (0.8 + 0.2 * tws) * (1 + boost * 0.6);
        ctx.fillStyle = `hsla(${s.hue},${sat}%,${82 + s.depth * 12}%,${a})`;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
        if (s.depth > 0.55) {
          const gr = ctx.createRadialGradient(x, y, 0, x, y, rad * 4);
          gr.addColorStop(0, `hsla(${s.hue},70%,75%,${a * 0.35})`);
          gr.addColorStop(1, `hsla(${s.hue},70%,75%,0)`);
          ctx.fillStyle = gr;
          ctx.beginPath(); ctx.arc(x, y, rad * 4, 0, TAU); ctx.fill();
        }
        if (s.sparkle && tws > 0.55) {
          const len = rad * (4 + 5 * tws);
          ctx.strokeStyle = `hsla(${s.hue},60%,85%,${a * 0.4})`;
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(x - len, y); ctx.lineTo(x + len, y);
          ctx.moveTo(x, y - len); ctx.lineTo(x, y + len);
          ctx.stroke();
        }
      }
    };

    const drawRipples = () => {
      for (const r of ripples) {
        const fall = 1 - r.age / r.life;
        ctx.strokeStyle = `hsla(${cfg.current.hue},60%,75%,${0.07 * fall * r.power})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(r.x, r.y, r.age * 260, 0, TAU); ctx.stroke();
      }
    };

    const drawShooters = () => {
      for (let i = 0; i < liveShooters; i++) {
        const s = shooters[i];
        const p = s.age / s.life;
        const fade = Math.sin(Math.PI * Math.min(p, 1));
        for (let j = 1; j < s.count; j++) {      // explicit fading tail from stored positions
          const a = (s.head - j + TRAIL) % TRAIL, b = (s.head - j - 1 + TRAIL) % TRAIL;
          const f = 1 - j / s.count;
          ctx.strokeStyle = `hsla(${s.hue},80%,88%,${0.7 * fade * f * f})`;
          ctx.lineWidth = 0.6 + 1.2 * f;
          ctx.beginPath(); ctx.moveTo(s.tx[a], s.ty[a]); ctx.lineTo(s.tx[b], s.ty[b]); ctx.stroke();
        }
        ctx.fillStyle = `hsla(${s.hue},90%,94%,${0.95 * fade})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, 1.8, 0, TAU); ctx.fill();
      }
    };

    const update = (dt: number) => {
      for (let i = ripples.length - 1; i >= 0; i--) {
        ripples[i].age += dt;
        if (ripples[i].age >= ripples[i].life) { ripples[i] = ripples[ripples.length - 1]; ripples.pop(); }
      }
      for (let i = liveShooters - 1; i >= 0; i--) {
        const s = shooters[i];
        s.age += dt; s.x += s.vx * dt; s.y += s.vy * dt;
        s.tx[s.head] = s.x; s.ty[s.head] = s.y;
        s.head = (s.head + 1) % TRAIL; s.count = Math.min(s.count + 1, TRAIL);
        if (s.age >= s.life || s.x > W + 50 || s.y > H + 50) {
          const last = shooters[--liveShooters];     // swap-remove, keep objects pooled
          shooters[i] = last; shooters[liveShooters] = s;
        }
      }
      const rate = cfg.current.shootingStarRate;
      if (rate > 0) {
        nextShot -= dt;
        if (nextShot <= 0) { spawnShooter(); nextShot = rand(2.5, 6) / rate; }
      }
    };

    let t = 0;
    const render = () => {
      ctx.clearRect(0, 0, W, H);                      // full clear: no ghosting
      drawNebulae(t);
      drawStars(t);
      drawRipples();
      drawShooters();
    };

    /* ---------- loop / lifecycle ---------- */
    let raf = 0, last = 0, visible = true, onScreen = true;
    const running = () => visible && onScreen && !reduceMotion;
    const tick = (now: number) => {
      raf = 0;
      if (!running()) return;
      const dt = Math.min((now - last) / 1000, 0.05); // clamp after tab switches
      last = now; t += dt;
      update(dt); render();
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (raf || !running()) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

    const onVis = () => { visible = !document.hidden; visible ? start() : stop(); };
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; onScreen ? start() : stop(); });
    const ro = new ResizeObserver(() => { resize(); if (!running()) render(); });

    resize();
    render();                                          // static frame (also used for reduced motion)
    io.observe(canvas); ro.observe(canvas);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    start();

    return () => {
      stop(); io.disconnect(); ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      rebuild.current = null;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block", width: "100%", height: "100%", background: "#03050d", ...style }}
      aria-hidden="true"
    />
  );
}
