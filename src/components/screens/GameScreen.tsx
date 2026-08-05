import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Choice } from '../../types/game';
import { copy } from '../../constants/copy';
import { REVEAL_DELAY_MS } from '../../constants/gameConfig';
import { ChoiceButton } from '../ChoiceButton';

const CHOICES: Choice[] = ['rock', 'paper', 'scissors'];

interface GameScreenProps {
  playerChoice: Choice | null;
  onPick: (choice: Choice) => void;
}

export function GameScreen({ playerChoice, onPick }: GameScreenProps) {
  if (playerChoice) {
    return <RevealingState playerChoice={playerChoice} />;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="flex flex-col items-center gap-8 text-center"
    >
      <p className="text-lg font-semibold text-slate-600">{copy.game.prompt}</p>
      <div className="flex flex-wrap items-center justify-center gap-6 sm:gap-10">
        {CHOICES.map((choice) => (
          <div key={choice} className="flex flex-col items-center gap-3">
            <ChoiceButton choice={choice} onSelect={onPick} />
            <span className="text-sm font-semibold text-slate-500">{copy.choices[choice]}</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function RevealingState({ playerChoice }: { playerChoice: Choice }) {
  const [step, setStep] = useState(0);
  const words = copy.game.countdown;

  useEffect(() => {
    setStep(0);
    const stepDuration = REVEAL_DELAY_MS / words.length;
    const interval = setInterval(() => {
      setStep((s) => Math.min(s + 1, words.length - 1));
    }, stepDuration);
    return () => clearInterval(interval);
  }, [playerChoice, words.length]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col items-center gap-8 text-center"
    >
      <ChoiceButton choice={playerChoice} selected size="lg" />
      <AnimatePresence mode="wait">
        <motion.p
          key={step}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
          className="text-2xl font-extrabold uppercase tracking-wide text-slate-700"
        >
          {words[step]}
        </motion.p>
      </AnimatePresence>
    </motion.div>
  );
}
