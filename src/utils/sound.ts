/**
 * Tiny SFX engine.
 *
 * Sounds are SYNTHESIZED with the Web Audio API rather than loaded from files.
 * That means: zero bytes of audio payload, nothing to preload (so no first-play
 * lag), and no licensing question at all — nothing here is sampled from any
 * existing recording.
 *
 * Everything is defensive: if AudioContext is missing, blocked, or throws, every
 * entry point degrades to a silent no-op and the game keeps working.
 */

export type SoundName =
  | 'select'
  | 'tick'
  | 'reveal'
  | 'roundWin'
  | 'roundLose'
  | 'roundTie'
  | 'matchWin';

import { readThemeAudio } from './themeTokens';
import { local } from './safeStorage';

const STORAGE_KEY = 'evenshock:muted';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = readStoredMuted();

/** Cap simultaneous voices so rapid rounds can't stack into noise. */
const MAX_VOICES = 8;
let activeVoices = 0;

/** Per-sound debounce, same reason. */
const MIN_REPEAT_MS = 45;
const lastPlayedAt: Partial<Record<SoundName, number>> = {};

function readStoredMuted(): boolean {
  // Storage refusing reads as "not muted", which is the right default: sound ON.
  return local.get(STORAGE_KEY) === 'true';
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  // Non-fatal if storage refuses: mute still applies for this session.
  local.set(STORAGE_KEY, String(next));
  if (ctx && master) {
    try {
      master.gain.setTargetAtTime(next ? 0 : 1, ctx.currentTime, 0.01);
    } catch {
      // Non-fatal.
    }
  }
}

/**
 * Lazily builds the AudioContext. MUST only ever be reached from a user gesture
 * (a click) — browsers block/throw otherwise, and we never want an autoplay
 * attempt before the player has interacted.
 */
function ensureContext(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Warm the audio context from a known user gesture, so the first tick is instant. */
export function unlockAudio(): void {
  if (muted) return;
  ensureContext();
}

interface ToneSpec {
  freq: number;
  dur: number;
  gain: number;
  type?: OscillatorType;
  at?: number;
  slideTo?: number;
  detune?: number;
}

function tone({ freq, dur, gain, type = 'sine', at = 0, slideTo, detune = 0 }: ToneSpec): void {
  if (!ctx || !master) return;
  if (activeVoices >= MAX_VOICES) return;

  const start = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();

  osc.type = type;
  try {
    osc.detune.setValueAtTime(detune, start);
  } catch {
    // detune unsupported — pitch is still correct without it.
  }
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);

  // Quick attack, exponential decay — reads as a percussive blip, not a beep.
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  osc.connect(env);
  env.connect(master);

  activeVoices += 1;
  osc.onended = () => {
    activeVoices -= 1;
    try {
      osc.disconnect();
      env.disconnect();
    } catch {
      // Already torn down.
    }
  };

  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** Filtered white-noise burst — gives the reveal its "impact" transient. */
function noise(dur: number, gain: number, at = 0): void {
  if (!ctx || !master) return;
  if (activeVoices >= MAX_VOICES) return;

  const start = ctx.currentTime + at;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1800, start);

  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, start);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  src.connect(filter);
  filter.connect(env);
  env.connect(master);

  activeVoices += 1;
  src.onended = () => {
    activeVoices -= 1;
    try {
      src.disconnect();
      filter.disconnect();
      env.disconnect();
    } catch {
      // Already torn down.
    }
  };

  src.start(start);
  src.stop(start + dur + 0.02);
}

export function play(name: SoundName): void {
  if (muted) return;

  const now = Date.now();
  if (now - (lastPlayedAt[name] ?? 0) < MIN_REPEAT_MS) return;
  lastPlayedAt[name] = now;

  if (!ensureContext()) return;

  // Audio character comes from the active theme: the waveform and the base
  // frequency every pitch below is derived from. Intervals stay fixed so each
  // sound keeps its meaning (rising = win, falling = lose) in every theme.
  const { wave, baseFreq: f, detune } = readThemeAudio();
  const t = wave;

  try {
    switch (name) {
      case 'select':
        tone({ freq: f, slideTo: f * 1.5, dur: 0.09, gain: 0.16, type: t, detune });
        break;

      // Repeats 3x per round, so it stays deliberately quiet and short.
      case 'tick':
        tone({ freq: f * 0.5, dur: 0.05, gain: 0.05, type: t, detune });
        break;

      case 'reveal':
        noise(0.12, 0.13);
        tone({ freq: f * 0.28, slideTo: f * 0.14, dur: 0.16, gain: 0.14, type: t, detune });
        break;

      case 'roundWin':
        tone({ freq: f, dur: 0.11, gain: 0.15, type: t, detune });
        tone({ freq: f * 1.5, dur: 0.18, gain: 0.15, type: t, at: 0.09, detune });
        break;

      case 'roundLose':
        tone({ freq: f * 0.75, dur: 0.12, gain: 0.13, type: t, detune });
        tone({ freq: f * 0.5, dur: 0.22, gain: 0.12, type: t, at: 0.1, detune });
        break;

      case 'roundTie':
        tone({ freq: f * 0.84, dur: 0.14, gain: 0.09, type: t, detune });
        break;

      case 'matchWin':
        [1, 1.26, 1.5, 2].forEach((ratio, i) => {
          tone({ freq: f * ratio, dur: 0.2, gain: 0.15, type: t, at: i * 0.09, detune });
        });
        break;
    }
  } catch {
    // Audio must never break gameplay.
  }
}
