import { motion } from 'framer-motion';
import type { Choice } from '../types/game';
import { CHOICE_ICONS } from './icons';
import { copy } from '../constants/copy';
import { play } from '../utils/sound';

const VARIANT_CLASSES: Record<Choice, string> = {
  rock: 'bg-rock shadow-rock/40',
  paper: 'bg-paper shadow-paper/40',
  scissors: 'bg-scissors shadow-scissors/40',
};

interface ChoiceButtonProps {
  choice: Choice;
  onSelect: (choice: Choice) => void;
  disabled?: boolean;
}

export function ChoiceButton({ choice, onSelect, disabled }: ChoiceButtonProps) {
  const Icon = CHOICE_ICONS[choice];

  const handleClick = () => {
    if (disabled) return;
    play('select');
    onSelect(choice);
  };

  return (
    <motion.button
      type="button"
      disabled={disabled}
      onClick={handleClick}
      aria-label={copy.choices[choice]}
      whileHover={disabled ? undefined : { scale: 1.08 }}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 400, damping: 18 }}
      className={`flex h-28 w-28 cursor-pointer items-center justify-center rounded-full text-white shadow-lg ring-4 ring-white/40 transition-opacity sm:h-36 sm:w-36 ${
        VARIANT_CLASSES[choice]
      } ${disabled ? 'opacity-40' : ''}`}
    >
      <Icon className="h-14 w-14 sm:h-18 sm:w-18" />
    </motion.button>
  );
}
