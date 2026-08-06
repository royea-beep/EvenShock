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
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false; // private mode / storage disabled — default to sound ON
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Non-fatal: mute still applies for this session.
  }
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
}

function tone({ freq, dur, gain, type = 'sine', at = 0, slideTo }: ToneSpec): void {
  if (!ctx || !master) return;
  if (activeVoices >= MAX_VOICES) return;

  const start = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();

  osc.type = type;
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

  try {
    switch (name) {
      case 'select':
        tone({ freq: 660, slideTo: 990, dur: 0.09, gain: 0.16, type: 'triangle' });
        break;

      // Repeats 3x per round, so it stays deliberately quiet and short.
      case 'tick':
        tone({ freq: 320, dur: 0.05, gain: 0.05, type: 'sine' });
        break;

      case 'reveal':
        noise(0.12, 0.13);
        tone({ freq: 180, slideTo: 90, dur: 0.16, gain: 0.14, type: 'triangle' });
        break;

      case 'roundWin':
        tone({ freq: 523.25, dur: 0.11, gain: 0.15, type: 'triangle' }); // C5
        tone({ freq: 783.99, dur: 0.18, gain: 0.15, type: 'triangle', at: 0.09 }); // G5
        break;

      case 'roundLose':
        tone({ freq: 392, dur: 0.12, gain: 0.13, type: 'sawtooth' }); // G4
        tone({ freq: 261.63, dur: 0.22, gain: 0.12, type: 'sawtooth', at: 0.1 }); // C4
        break;

      case 'roundTie':
        tone({ freq: 440, dur: 0.14, gain: 0.09, type: 'sine' }); // A4
        break;

      case 'matchWin':
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
          tone({ freq, dur: 0.2, gain: 0.15, type: 'triangle', at: i * 0.09 });
        });
        break;
    }
  } catch {
    // Audio must never break gameplay.
  }
}
