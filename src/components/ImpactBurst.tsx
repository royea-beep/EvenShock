import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';
import type { ThemeId } from '../constants/themes';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  colour: string;
  gravity: number;
  drag: number;
}

interface Profile {
  count: number;
  colours: string[];
  speed: [number, number];
  size: [number, number];
  gravity: number;
  drag: number;
  /** Upward bias, for things that rise rather than fall. */
  lift: number;
  life: number;
}

/**
 * One profile per theme, because the four were chosen partly for the energy
 * each implies. Studio is deliberately the quietest — a photographed hand
 * should not sprout cartoon particles, so it gets a short, sparse dust puff
 * rather than a burst.
 */
const PROFILES: Record<ThemeId, Profile> = {
  molten: {
    count: 24,
    colours: ['#ffb703', '#e8763a', '#ffd88a', '#d9524a'],
    speed: [110, 340],
    size: [1.5, 3.4],
    gravity: -110, // embers rise
    drag: 0.86,
    lift: 0.45,
    life: 620,
  },
  ink: {
    count: 18,
    colours: ['#1d1a15', '#2c2721', '#5e564a'],
    speed: [130, 380],
    size: [2, 5.5],
    gravity: 420,
    drag: 0.8,
    lift: 0.1,
    life: 520,
  },
  marble: {
    count: 20,
    colours: ['#cdcbc5', '#b3a996', '#8b8375', '#f3f0e9'],
    speed: [90, 300],
    size: [1.4, 3.8],
    gravity: 560, // chips fall
    drag: 0.83,
    lift: 0.2,
    life: 560,
  },
  studio: {
    count: 12,
    colours: ['#d6d1cb', '#efedea', '#b8b0a6'],
    speed: [50, 140],
    size: [1.2, 2.6],
    gravity: 60,
    drag: 0.9,
    lift: 0.3,
    life: 460,
  },
  highroller: {
    // Gold sparkle rain like the sparkle field behind the curtain in the art.
    count: 22,
    colours: ['#e3b96c', '#b8813a', '#f4d896', '#d9754a'],
    speed: [90, 260],
    size: [1.2, 2.8],
    gravity: 180,
    drag: 0.87,
    lift: 0.35,
    life: 580,
  },
  frost: {
    // Ice shards that fall + a scatter of cyan glints. Cold palette matches
    // the artwork so the burst reads as chipped ice, not sparks.
    count: 22,
    colours: ['#7ec1de', '#2e6a8c', '#e6f1f8', '#59a6cc'],
    speed: [100, 300],
    size: [1.4, 3.4],
    gravity: 500,
    drag: 0.85,
    lift: 0.12,
    life: 540,
  },
  jade: {
    // Porcelain chips: cool celadon greens falling like fragments off a
    // dropped figurine. Quiet — the theme is stillness, not celebration.
    count: 16,
    colours: ['#b3d1c3', '#7ab097', '#edf2ee', '#3c6256'],
    speed: [80, 240],
    size: [1.4, 3.6],
    gravity: 540,
    drag: 0.86,
    lift: 0.15,
    life: 500,
  },
  origami: {
    // Coral + lilac paper triangles fluttering as they fall. Slow drift on
    // low gravity + high drag reads as paper, not stone.
    count: 20,
    colours: ['#d55c40', '#f4b5a0', '#a78ac9', '#d5c7de'],
    speed: [90, 240],
    size: [1.6, 3.8],
    gravity: 260,
    drag: 0.9,
    lift: 0.25,
    life: 620,
  },
};

interface ImpactBurstProps {
  /** Bumped to fire a burst; null means nothing has landed yet. */
  fireKey: number | null;
  theme: ThemeId;
}

/**
 * A one-shot particle burst at the point of contact, on canvas.
 *
 * Cheap on purpose: no physics engine, no dependency, one rAF loop that stops
 * itself when the last particle dies. It only ever runs on match-deciding
 * rounds, so the cost is paid roughly once per match rather than once a round.
 */
export function ImpactBurst({ fireKey, theme }: ImpactBurstProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();

  // Size the backing store as soon as the canvas exists — which is during the
  // build-up, not at the snap. Allocating and scaling it on the impact frame
  // cost a measured 122ms hitch at 4x throttle, landing exactly on the beat the
  // whole sequence builds to.
  const sizeRef = useRef({ width: 0, height: 0 });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reducedMotion) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Cap the backing store at 2x. Beyond that the particle count, not the
    // resolution, is what the eye reads, and a 3x buffer on a large phone is
    // pure fill cost during the most frame-sensitive moment of the round.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sizeRef.current = { width, height };
  }, [reducedMotion]);

  useEffect(() => {
    if (fireKey === null || reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = sizeRef.current;
    if (!width || !height) return;

    const profile = PROFILES[theme];
    const originX = width / 2;
    const originY = height / 2;
    const particles: Particle[] = [];

    for (let i = 0; i < profile.count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = profile.speed[0] + Math.random() * (profile.speed[1] - profile.speed[0]);
      particles.push({
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - profile.lift * speed,
        life: profile.life * (0.65 + Math.random() * 0.35),
        size: profile.size[0] + Math.random() * (profile.size[1] - profile.size[0]),
        colour: profile.colours[Math.floor(Math.random() * profile.colours.length)],
        gravity: profile.gravity,
        drag: profile.drag,
      });
    }

    let raf = 0;
    let last = performance.now();
    const started = last;

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      ctx.clearRect(0, 0, width, height);

      let alive = false;
      for (const p of particles) {
        const age = now - started;
        if (age > p.life) continue;
        alive = true;
        p.vy += p.gravity * dt;
        p.vx *= Math.pow(p.drag, dt * 60);
        p.vy *= Math.pow(p.drag, dt * 60);
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        ctx.globalAlpha = Math.max(0, 1 - age / p.life);
        ctx.fillStyle = p.colour;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (alive) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, width, height);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, width, height);
    };
  }, [fireKey, theme, reducedMotion]);

  if (reducedMotion) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 h-full w-full"
    />
  );
}
