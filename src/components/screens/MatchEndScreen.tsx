import { motion } from 'framer-motion';
import type { Score } from '../../types/game';
import { copy } from '../../constants/copy';

interface MatchEndScreenProps {
  score: Score;
  matchWinner: 'player' | 'opponent' | null;
  onPlayAgain: () => void;
}

export function MatchEndScreen({ score, matchWinner, onPlayAgain }: MatchEndScreenProps) {
  const bannerText = matchWinner ? copy.matchEnd.winnerBanner[matchWinner] : '';
  const bannerClass = matchWinner === 'player' ? 'text-win' : 'text-lose';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="flex flex-col items-center gap-8 text-center"
    >
      <motion.h2
        initial={{ scale: 0.8 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 12 }}
        className={`text-4xl font-extrabold ${bannerClass}`}
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
        className="rounded-full bg-scissors px-10 py-4 text-lg font-bold text-white shadow-lg shadow-scissors/40"
      >
        {copy.matchEnd.playAgainButton}
      </motion.button>
    </motion.div>
  );
}
