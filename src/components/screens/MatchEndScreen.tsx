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
          className={`display-type text-4xl font-extrabold ${playerWon ? 'text-win' : 'text-muted'}`}
        >
          {bannerText}
        </motion.h2>

        <div className="space-y-1">
          <p className="display-type text-sm font-semibold text-muted">
            {copy.matchEnd.finalScoreLabel}
          </p>
          <p className="display-type text-3xl font-bold text-ink">
            {score.player} – {score.opponent}
          </p>
        </div>

        <motion.button
          type="button"
          onClick={onPlayAgain}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          style={{
            borderRadius: 'var(--radius-themed-md)',
            boxShadow: 'var(--shadow-card)',
            borderWidth: 'var(--border-width)',
            borderColor: 'var(--border-color)',
            borderStyle: 'var(--border-style)',
          }}
          className={`display-type cursor-pointer px-10 py-4 text-lg font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${
            playerWon ? 'bg-scissors text-scissors-ink' : 'bg-elevated text-ink'
          }`}
        >
          {copy.matchEnd.playAgainButton}
        </motion.button>
      </motion.div>
    </>
  );
}
