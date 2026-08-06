import { motion } from 'framer-motion';
import type { Choice } from '../types/game';
import type { ImageSet } from '../assets/themes';
import { play } from '../utils/sound';
import { MoveArt } from './MoveArt';

/** Backs the artwork, and shows through when a theme has no art set. */
const VARIANT_CLASSES: Record<Choice, string> = {
  rock: 'bg-rock text-rock-ink',
  paper: 'bg-paper text-paper-ink',
  scissors: 'bg-scissors text-scissors-ink',
};

interface ChoiceButtonProps {
  choice: Choice;
  imageSet: ImageSet | null;
  onSelect?: (choice: Choice) => void;
  disabled?: boolean;
  /** Non-interactive rendering for the theme-picker previews. */
  preview?: boolean;
}

export function ChoiceButton({
  choice,
  imageSet,
  onSelect,
  disabled,
  preview,
}: ChoiceButtonProps) {
  const handleClick = () => {
    if (disabled || preview) return;
    play('select');
    onSelect?.(choice);
  };

  // Below `sm` the three moves must fit one row on the narrowest phones we care
  // about (320px). A fixed 112px square overflowed at 360px and wrapped
  // scissors onto its own line, so the play size is viewport-relative until the
  // breakpoint, where it locks to a fixed 144px.
  const size = preview ? 'h-11 w-11' : 'h-[24vw] w-[24vw] sm:h-36 sm:w-36';
  const iconSize = preview ? 'h-5 w-5' : 'h-[12vw] w-[12vw] sm:h-18 sm:w-18';

  return (
    <motion.button
      type="button"
      disabled={disabled || preview}
      tabIndex={preview ? -1 : undefined}
      aria-hidden={preview || undefined}
      onClick={handleClick}
      // Transform-only hover/tap so the compositor handles it, not layout.
      whileHover={disabled || preview ? undefined : { scale: 1.08 }}
      whileTap={disabled || preview ? undefined : { scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 400, damping: 18 }}
      style={{
        borderRadius: 'var(--radius-choice)',
        boxShadow: preview ? undefined : 'var(--shadow-choice), var(--glow-choice)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
      }}
      className={`flex ${size} shrink-0 items-center justify-center overflow-hidden transition-opacity ${
        VARIANT_CLASSES[choice]
      } ${disabled && !preview ? 'opacity-40' : ''} ${preview ? '' : 'cursor-pointer'}`}
    >
      <MoveArt
        choice={choice}
        imageSet={imageSet}
        size={preview ? 'thumb' : 'full'}
        decorative={preview}
        lazy={preview}
        iconClassName={iconSize}
      />
    </motion.button>
  );
}
