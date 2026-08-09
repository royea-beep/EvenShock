import { motion } from 'framer-motion';
import type { RoundOutcome } from '../../types/game';
import type { ThemeId } from '../../constants/themes';
import { ImpactBurst } from '../ImpactBurst';
import { IMPACT_VARIANT, type ImpactVariant } from '../../utils/impactVariant';

/**
 * TEMPORARY: renders the impact overlays for one of the four variants.
 *
 * ============================ REMOVING THIS ============================
 * When a variant is chosen, keep only that variant's JSX inline in RoundScreen
 * (delete this component, revert RoundScreen to owning its own overlays) or
 * pick this module up as the permanent one and delete the other three
 * variants. See utils/impactVariant.ts for the full removal list.
 * ======================================================================
 *
 * Renders NOTHING when the round has no big-payoff (routine, tie, or reduced
 * motion) — the parent gates this at the mount site. Every variant reads only
 * `roundResult` and `roundNumber` from the game, both of which resolve strictly
 * after the reveal has landed, so no variant can carry information about the
 * bot's move earlier than the shipped code does.
 */

const FLASH_CLASSES: Record<RoundOutcome, string> = {
  win: 'bg-win',
  lose: 'bg-lose',
  tie: 'bg-tie',
};

interface ImpactEffectsProps {
  roundNumber: number;
  roundResult: RoundOutcome;
  burstKey: number | null;
  theme: ThemeId;
  /** True when this round earns the full payoff (deciding + !reducedMotion). */
  active: boolean;
}

export function ImpactEffects(props: ImpactEffectsProps) {
  if (!props.active) return null;
  switch (IMPACT_VARIANT) {
    case 'a':
      return <VariantA {...props} />;
    case 'b':
      return <VariantB {...props} />;
    case 'c':
      return <VariantC {...props} />;
    case 'd':
      return <VariantD {...props} />;
  }
}

/** A — Current: colored flash, white hit, shockwave ring, particles. */
function VariantA({ roundNumber, roundResult, burstKey, theme }: ImpactEffectsProps) {
  return (
    <>
      <ColoredFlash
        roundNumber={roundNumber}
        outcome={roundResult}
        durationSec={0.6}
        peak={0.35}
        peakAt={0.18}
      />
      <WhiteHit roundNumber={roundNumber} durationSec={0.1} peak={0.5} peakAt={0.3} />
      {roundResult !== 'tie' && <ShockwaveRing roundNumber={roundNumber} />}
      <ImpactBurst fireKey={burstKey} theme={theme} />
    </>
  );
}

/** B — Hit-stop: the flash is at contact, then almost nothing, then release.
 *  The freeze is done in HandsFaceOff (a 120ms pause on the first two
 *  keyframes); here we just fire the short punctuation and delay the particles
 *  to land after the release. No ring — the point of the treatment is
 *  REMOVING stimulus for a beat, not adding another. */
function VariantB({ roundNumber, roundResult, burstKey, theme }: ImpactEffectsProps) {
  return (
    <>
      {/* Snappy white hit at contact — 60ms so it reads as "impact", not "flash". */}
      <WhiteHit roundNumber={roundNumber} durationSec={0.06} peak={0.6} peakAt={0.3} />
      {/* Colored flash held slightly longer than the hit, but short. */}
      <ColoredFlash
        roundNumber={roundNumber}
        outcome={roundResult}
        durationSec={0.28}
        peak={0.28}
        peakAt={0.15}
      />
      {/* Particles delayed until the freeze releases (~120ms), so they read as
          "held tension released" rather than firing during the still frame. */}
      <ImpactBurst fireKey={burstKey} theme={theme} startDelayMs={120} />
    </>
  );
}

/** C — Cinematic: letterbox bars slide in, hold for the beat. No flash, no
 *  ring, no particles. Slow knockback and slow winner push-in live in
 *  HandsFaceOff (impact runs at ~1.0s under variant C). */
function VariantC({ roundNumber }: ImpactEffectsProps) {
  return <LetterboxBars roundNumber={roundNumber} />;
}

/** D — Crush: bigger flash + hit + speed lines + particles. The multi-axis
 *  screen shake and the loser being thrown off-screen are done in App.tsx and
 *  HandsFaceOff respectively — those two live where the shake targets and the
 *  hand keyframes are. */
function VariantD({ roundNumber, roundResult, burstKey, theme }: ImpactEffectsProps) {
  return (
    <>
      <ColoredFlash
        roundNumber={roundNumber}
        outcome={roundResult}
        durationSec={0.45}
        peak={0.5}
        peakAt={0.15}
      />
      <WhiteHit roundNumber={roundNumber} durationSec={0.14} peak={0.7} peakAt={0.25} />
      {roundResult !== 'tie' && <SpeedLines roundNumber={roundNumber} />}
      <ImpactBurst fireKey={burstKey} theme={theme} />
    </>
  );
}

// ------------------------------------------------------------------ primitives

function ColoredFlash({
  roundNumber,
  outcome,
  durationSec,
  peak,
  peakAt,
}: {
  roundNumber: number;
  outcome: RoundOutcome;
  durationSec: number;
  peak: number;
  peakAt: number;
}) {
  return (
    <motion.div
      key={`flash-${roundNumber}`}
      aria-hidden="true"
      style={{ borderRadius: 'var(--radius-themed-md)' }}
      className={`pointer-events-none absolute inset-0 ${FLASH_CLASSES[outcome]}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, peak, 0] }}
      transition={{ duration: durationSec, times: [0, peakAt, 1], ease: 'easeOut' }}
    />
  );
}

/** White hit: a strobe is a health hazard, one rise + one fall only.
 *  Confined to the stage, never to the viewport. */
function WhiteHit({
  roundNumber,
  durationSec,
  peak,
  peakAt,
}: {
  roundNumber: number;
  durationSec: number;
  peak: number;
  peakAt: number;
}) {
  return (
    <motion.div
      key={`hit-${roundNumber}`}
      aria-hidden="true"
      style={{ borderRadius: 'var(--radius-themed-md)', backgroundColor: '#ffffff' }}
      className="pointer-events-none absolute inset-0 z-30"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, peak, 0] }}
      transition={{ duration: durationSec, times: [0, peakAt, 1], ease: 'easeOut' }}
    />
  );
}

/** Ring: expanding shockwave, centered on the contact point. */
function ShockwaveRing({ roundNumber }: { roundNumber: number }) {
  return (
    <motion.span
      key={`ring-${roundNumber}`}
      aria-hidden="true"
      initial={{ opacity: 0.5, scale: 0.15 }}
      animate={{ opacity: 0, scale: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      style={{ borderColor: 'var(--text-primary)' }}
      className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-[42vw] w-[42vw] max-h-96 max-w-96 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
    />
  );
}

/** Two black bars slide in from off-screen; hold for the rest of the impact.
 *  Sits on top of the hands stage only — not the viewport — so the outcome
 *  text and advance button below remain fully legible. */
function LetterboxBars({ roundNumber }: { roundNumber: number }) {
  const bar = 'pointer-events-none absolute left-0 right-0 z-30 h-[14%] bg-black';
  return (
    <>
      <motion.div
        key={`bar-top-${roundNumber}`}
        aria-hidden="true"
        className={`${bar} top-0`}
        initial={{ y: '-100%' }}
        animate={{ y: '0%' }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      />
      <motion.div
        key={`bar-bottom-${roundNumber}`}
        aria-hidden="true"
        className={`${bar} bottom-0`}
        initial={{ y: '100%' }}
        animate={{ y: '0%' }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      />
    </>
  );
}

/** Eight radial lines from the contact point, spreading outward and fading.
 *  Confined to the stage. Rotation baked into the transform on each child so
 *  each line reads as its own vector rather than a spinning group. */
function SpeedLines({ roundNumber }: { roundNumber: number }) {
  const lines = Array.from({ length: 8 }, (_, i) => i * 45);
  return (
    <div
      aria-hidden="true"
      key={`speedlines-${roundNumber}`}
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center overflow-hidden"
    >
      {lines.map((deg) => (
        <motion.span
          key={deg}
          style={{
            transform: `rotate(${deg}deg)`,
            backgroundColor: 'var(--text-primary)',
            transformOrigin: 'left center',
          }}
          className="absolute left-1/2 top-1/2 h-[3px] w-[60vw] max-w-[36rem] origin-left"
          initial={{ scaleX: 0, opacity: 0.6 }}
          animate={{ scaleX: 1, opacity: 0 }}
          transition={{ duration: 0.28, ease: 'easeOut' }}
        />
      ))}
    </div>
  );
}

// ------------------------------------------ helpers reused by consumers

/** For consumers that need to know whether to skip / adapt other overlays.
 *  Cheaper than importing IMPACT_VARIANT everywhere. */
export function isVariant(v: ImpactVariant): boolean {
  return IMPACT_VARIANT === v;
}
