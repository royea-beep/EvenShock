import { motion } from 'framer-motion';
import type { Choice } from '../types/game';
import { CHOICE_ICONS } from './icons';
import { copy } from '../constants/copy';
import { play } from '../utils/sound';

/** Fill + icon color both come from theme tokens, so each theme picks its own trio. */
const VARIANT_CLASSES: Record<Choice, string> = {
  rock: 'bg-rock text-rock-ink',
  paper: 'bg-paper text-paper-ink',
  scissors: 'bg-scissors text-scissors-ink',
};

interface ChoiceButtonProps {
  choice: Choice;
  onSelect?: (choice: Choice) => void;
  disabled?: boolean;
  /** Non-interactive rendering for the theme picker previews. */
  preview?: boolean;
}

export function ChoiceButton({ choice, onSelect, disabled, preview }: ChoiceButtonProps) {
  const Icon = CHOICE_ICONS[choice];

  const handleClick = () => {
    if (disabled || preview) return;
    play('select');
    onSelect?.(choice);
  };

  const size = preview ? 'h-10 w-10' : 'h-28 w-28 sm:h-36 sm:w-36';
  const iconSize = preview ? 'h-5 w-5' : 'h-14 w-14 sm:h-18 sm:w-18';

  return (
    <motion.button
      type="button"
      disabled={disabled || preview}
      tabIndex={preview ? -1 : undefined}
      aria-hidden={preview || undefined}
      onClick={handleClick}
      aria-label={preview ? undefined : copy.choices[choice]}
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
      className={`flex ${size} shrink-0 items-center justify-center transition-opacity ${
        VARIANT_CLASSES[choice]
      } ${disabled && !preview ? 'opacity-40' : ''} ${preview ? '' : 'cursor-pointer'}`}
    >
      <Icon className={iconSize} />
    </motion.button>
  );
}
