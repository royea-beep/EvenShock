import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { Score } from '../../types/game';
import { copy } from '../../constants/copy';
import { Confetti } from '../Confetti';
import { play } from '../../utils/sound';

interface MatchEndScreenProps {
  score: Score;
  matchWinner: 'player' | 'opponent' | null;
  onPlayAgain: () => void;
}

export function MatchEndScreen({ score, matchWinner, onPlayAgain }: MatchEndScreenProps) {
  const reducedMotion = useReducedMotion();
  const playerWon = matchWinner === 'player';

  const soundPlayed = useRef(false);
  useEffect(() => {
    if (playerWon && !soundPlayed.current) {
      soundPlayed.current = true;
      play('matchWin');
    }
  }, [playerWon]);

  const bannerText = matchWinner ? copy.matchEnd.winnerBanner[matchWinner] : '';

  return (
    <>
      <Confetti active={playerWon} />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        // Losing the match reads as subdued rather than harsh: the whole panel
        // desaturates instead of turning aggressive.
        className={`flex flex-col items-center gap-8 text-center ${
          playerWon ? '' : 'opacity-90 saturate-50'
        }`}
      >
        <motion.h2
          initial={reducedMotion ? { scale: 1 } : { scale: 0.8 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 12 }}
          className={`text-4xl font-extrabold ${playerWon ? 'text-win' : 'text-slate-500'}`}
        >
          {bannerText}
        </motion.h2>

        <div className="space-y-1">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            {copy.matchEnd.finalScoreLabel}
          </p>
          <p className="text-3xl font-bold text-slate-700">
            {score.player} – {score.opponent}
          </p>
        </div>

        <motion.button
          type="button"
          onClick={onPlayAgain}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className={`rounded-full px-10 py-4 text-lg font-bold text-white shadow-lg ${
            playerWon ? 'bg-scissors shadow-scissors/40' : 'bg-slate-700'
          }`}
        >
          {copy.matchEnd.playAgainButton}
        </motion.button>
      </motion.div>
    </>
  );
}
