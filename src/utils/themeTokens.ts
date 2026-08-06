/**
 * Reads the motion and audio character tokens out of the active theme.
 *
 * These live in CSS alongside every other token (so a theme is authored in one
 * place, and the parity test covers them) but are consumed by JS — Framer
 * Motion needs a bezier array, and the Web Audio engine needs a waveform and a
 * frequency. Everything here is defensive: a missing or malformed token falls
 * back to a sane baseline rather than throwing.
 */

export interface ThemeMotion {
  /** Cubic-bezier control points for Framer Motion's `ease`. */
  ease: [number, number, number, number];
  /** Duration multiplier: 1 = baseline, >1 slower. */
  scale: number;
}

export interface ThemeAudio {
  wave: OscillatorType;
  baseFreq: number;
  detune: number;
}

const DEFAULT_MOTION: ThemeMotion = { ease: [0.25, 0.1, 0.25, 1], scale: 1 };
const DEFAULT_AUDIO: ThemeAudio = { wave: 'sine', baseFreq: 520, detune: 0 };

const VALID_WAVES: OscillatorType[] = ['sine', 'square', 'sawtooth', 'triangle'];

function readToken(name: string, el?: Element): string {
  try {
    const target = el ?? document.documentElement;
    return getComputedStyle(target).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

export function readThemeMotion(el?: Element): ThemeMotion {
  const rawEase = readToken('--motion-ease', el);
  const rawScale = Number.parseFloat(readToken('--motion-scale', el));

  const parts = rawEase
    .split(',')
    .map((n) => Number.parseFloat(n.trim()))
    .filter((n) => Number.isFinite(n));

  return {
    ease: parts.length === 4 ? (parts as [number, number, number, number]) : DEFAULT_MOTION.ease,
    scale: Number.isFinite(rawScale) && rawScale > 0 ? rawScale : DEFAULT_MOTION.scale,
  };
}

export function readThemeAudio(el?: Element): ThemeAudio {
  const wave = readToken('--audio-wave', el).replace(/['"]/g, '') as OscillatorType;
  const baseFreq = Number.parseFloat(readToken('--audio-base-freq', el));
  const detune = Number.parseFloat(readToken('--audio-detune', el));

  return {
    wave: VALID_WAVES.includes(wave) ? wave : DEFAULT_AUDIO.wave,
    baseFreq: Number.isFinite(baseFreq) && baseFreq > 0 ? baseFreq : DEFAULT_AUDIO.baseFreq,
    detune: Number.isFinite(detune) ? detune : DEFAULT_AUDIO.detune,
  };
}

/** Resolves a color token to a concrete value — needed by canvas (confetti). */
export function readColorToken(name: string, el?: Element): string {
  return readToken(name, el) || '#888888';
}
