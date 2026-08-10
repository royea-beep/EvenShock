import { useCallback, useEffect, useRef, useState } from 'react';
import type { Choice, MatchFormat, MatchStatus, RoundOutcome, Score } from '../types/game';
import { getBotChoice } from '../utils/getBotChoice';
import { getMatchWinner, getRoundOutcome, isMatchComplete } from '../utils/gameLogic';
import { REVEAL_DELAY_MS } from '../constants/gameConfig';

const INITIAL_SCORE: Score = { player: 0, opponent: 0 };

interface UseGameOptions {
  /**
   * Resolves the opponent's move for a round. Defaults to the local random
   * bot. Swap this for a function that reads a real opponent's move off a
   * Supabase Realtime `matches` row to go multiplayer — the rest of the hook
   * (and every screen built on it) is unaware of where the choice came from.
   *
   * Receives the player's move because commit-reveal needs it: the server has
   * already committed to its own move, and the player's is what unlocks the
   * reveal. This is the hook's only concession to the server being
   * authoritative — the return value is still just a Choice.
   *
   * MAY STAY PENDING. The resolver owns retries and failure messaging, and the
   * round screen derives its phase from state rather than a timer, so an
   * unresolved promise holds the wind-up instead of desyncing it. It must never
   * REJECT: nothing here would catch it.
   */
  resolveOpponentChoice?: (playerChoice: Choice) => Choice | Promise<Choice>;
}

export function useGame({ resolveOpponentChoice = getBotChoice }: UseGameOptions = {}) {
  const [format, setFormat] = useState<MatchFormat>('single');
  const [matchStatus, setMatchStatus] = useState<MatchStatus>('idle');
  const [playerChoice, setPlayerChoice] = useState<Choice | null>(null);
  const [botChoice, setBotChoice] = useState<Choice | null>(null);
  const [roundResult, setRoundResult] = useState<RoundOutcome | null>(null);
  const [score, setScore] = useState<Score>(INITIAL_SCORE);
  const [roundNumber, setRoundNumber] = useState(1);
  const [showMatchEnd, setShowMatchEnd] = useState(false);

  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, []);

  const startMatch = useCallback(() => {
    setScore(INITIAL_SCORE);
    setRoundNumber(1);
    setPlayerChoice(null);
    setBotChoice(null);
    setRoundResult(null);
    setShowMatchEnd(false);
    setMatchStatus('playing');
  }, []);

  const pickChoice = useCallback(
    (choice: Choice) => {
      setPlayerChoice(choice);
      setBotChoice(null);
      setRoundResult(null);

      revealTimer.current = setTimeout(async () => {
        const opponentChoice = await resolveOpponentChoice(choice);
        const outcome = getRoundOutcome(choice, opponentChoice);

        setBotChoice(opponentChoice);
        setRoundResult(outcome);

        if (outcome === 'tie') return; // tie: score untouched, replay this round

        setScore((prev) => {
          const next: Score =
            outcome === 'win'
              ? { ...prev, player: prev.player + 1 }
              : { ...prev, opponent: prev.opponent + 1 };

          if (isMatchComplete(next, format)) {
            setMatchStatus('complete');
          }
          return next;
        });
      }, REVEAL_DELAY_MS);
    },
    [format, resolveOpponentChoice],
  );

  const nextRound = useCallback(() => {
    setRoundNumber((n) => n + 1);
    setPlayerChoice(null);
    setBotChoice(null);
    setRoundResult(null);
  }, []);

  const playAgain = useCallback(() => {
    setMatchStatus('idle');
    setPlayerChoice(null);
    setBotChoice(null);
    setRoundResult(null);
    setScore(INITIAL_SCORE);
    setRoundNumber(1);
    setShowMatchEnd(false);
    // `format` is intentionally left as-is so Home shows it pre-selected.
  }, []);

  /** Advances from the round-result screen: to the next round, or to match end if the match just finished. */
  const continueFromResult = useCallback(() => {
    if (matchStatus === 'complete') {
      setShowMatchEnd(true);
    } else {
      nextRound();
    }
  }, [matchStatus, nextRound]);

  return {
    format,
    setFormat,
    matchStatus,
    playerChoice,
    botChoice,
    roundResult,
    score,
    roundNumber,
    showMatchEnd,
    matchWinner: getMatchWinner(score),
    startMatch,
    pickChoice,
    nextRound,
    continueFromResult,
    playAgain,
  };
}

export type UseGameReturn = ReturnType<typeof useGame>;
