import { motion } from 'framer-motion';
import type { Choice } from '../types/game';
import { CHOICE_ICONS } from './icons';
import { copy } from '../constants/copy';

const VARIANT_CLASSES: Record<Choice, string> = {
  rock: 'bg-rock shadow-rock/40',
  paper: 'bg-paper shadow-paper/40',
  scissors: 'bg-scissors shadow-scissors/40',
};

interface ChoiceButtonProps {
  choice: Choice;
  onSelect?: (choice: Choice) => void;
  size?: 'lg' | 'md';
  disabled?: boolean;
  selected?: boolean;
}

export function ChoiceButton({ choice, onSelect, size = 'lg', disabled, selected }: ChoiceButtonProps) {
  const Icon = CHOICE_ICONS[choice];
  const dimension = size === 'lg' ? 'h-28 w-28 sm:h-36 sm:w-36' : 'h-20 w-20 sm:h-24 sm:w-24';
  const iconSize = size === 'lg' ? 'h-14 w-14 sm:h-18 sm:w-18' : 'h-10 w-10 sm:h-12 sm:w-12';

  return (
    <motion.button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.(choice)}
      aria-label={copy.choices[choice]}
      aria-pressed={selected}
      whileHover={onSelect && !disabled ? { scale: 1.08 } : undefined}
      whileTap={onSelect && !disabled ? { scale: 0.94 } : undefined}
      animate={selected ? { scale: [1, 1.12, 1] } : { scale: 1 }}
      transition={selected ? { duration: 0.6, repeat: Infinity } : { duration: 0.2 }}
      className={`flex ${dimension} items-center justify-center rounded-full text-white shadow-lg ring-4 ring-white/40 transition-opacity ${VARIANT_CLASSES[choice]} ${
        disabled && !selected ? 'opacity-40' : ''
      } ${onSelect ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <Icon className={iconSize} />
    </motion.button>
  );
}
