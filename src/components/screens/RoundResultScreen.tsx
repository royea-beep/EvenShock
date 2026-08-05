import { motion } from 'framer-motion';
import type { Choice, MatchStatus, RoundOutcome, Score } from '../../types/game';
import { copy } from '../../constants/copy';
import { ChoiceButton } from '../ChoiceButton';

const OUTCOME_TEXT_CLASSES: Record<RoundOutcome, string> = {
  win: 'text-win',
  lose: 'text-lose',
  tie: 'text-tie',
};

interface RoundResultScreenProps {
  playerChoice: Choice;
  botChoice: Choice;
  roundResult: RoundOutcome;
  score: Score;
  matchStatus: MatchStatus;
  onContinue: () => void;
}

export function RoundResultScreen({
  playerChoice,
  botChoice,
  roundResult,
  score,
  matchStatus,
  onContinue,
}: RoundResultScreenProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="flex flex-col items-center gap-8 text-center"
    >
      <div className="flex items-center justify-center gap-8 sm:gap-16">
        <div className="flex flex-col items-center gap-3">
          <ChoiceButton choice={playerChoice} size="md" />
          <span className="text-sm font-semibold text-slate-500">{copy.game.youLabel}</span>
        </div>
        <span className="text-2xl font-black text-slate-300">VS</span>
        <div className="flex flex-col items-center gap-3">
          <ChoiceButton choice={botChoice} size="md" />
          <span className="text-sm font-semibold text-slate-500">{copy.game.opponentLabel}</span>
        </div>
      </div>

      <p className={`text-3xl font-extrabold ${OUTCOME_TEXT_CLASSES[roundResult]}`}>
        {copy.roundResult.outcome[roundResult]}
      </p>

      <div className="flex items-center gap-2 text-slate-500">
        <span className="text-sm font-semibold uppercase tracking-wide">{copy.roundResult.scoreLabel}</span>
        <span className="text-lg font-bold text-slate-700">
          {score.player} – {score.opponent}
        </span>
      </div>

      <motion.button
        type="button"
        onClick={onContinue}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="rounded-full bg-slate-800 px-8 py-3 text-base font-bold text-white shadow-lg"
      >
        {matchStatus === 'complete' ? copy.roundResult.seeResultsButton : copy.roundResult.nextRoundButton}
      </motion.button>
    </motion.div>
  );
}
