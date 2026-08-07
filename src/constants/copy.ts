import type { Choice, MatchFormat, RoundOutcome } from '../types/game';

/**
 * All UI copy lives here. Nothing user-facing should be a string literal in a
 * component — keeps this file the single place to translate later.
 */
export const copy = {
  home: {
    title: 'EvenShock',
    subtitle: 'Rock. Paper. Scissors. Outsmart the bot.',
    formatLabel: 'Choose a format',
    startButton: 'Start game',
  },
  formats: {
    single: 'Single Round',
    bo3: 'Best of 3',
    bo5: 'Best of 5',
  } satisfies Record<MatchFormat, string>,
  choices: {
    rock: 'Rock',
    paper: 'Paper',
    scissors: 'Scissors',
  } satisfies Record<Choice, string>,
  game: {
    prompt: 'Make your move',
    countdown: ['Rock...', 'Paper...', 'Scissors...', 'Shoot!'],
    youLabel: 'You',
    opponentLabel: 'Bot',
  },
  roundResult: {
    outcome: {
      win: 'You win!',
      lose: 'You lose',
      tie: "It's a tie — go again",
    } satisfies Record<RoundOutcome, string>,
    scoreLabel: 'Score',
    nextRoundButton: 'Next round',
    seeResultsButton: 'See results',
  },
  status: {
    roundLabel: 'Round',
    youLabel: 'You',
    botLabel: 'Bot',
    historyLabel: 'Rounds so far',
    /** Screen-reader wording for a history pill; the glyph alone is visual. */
    historyEntry: {
      win: 'won',
      lose: 'lost',
      tie: 'tied',
    } satisfies Record<RoundOutcome, string>,
  },
  matchEnd: {
    winnerBanner: {
      player: 'You won the match!',
      opponent: 'The bot won this time',
    } as Record<'player' | 'opponent', string>,
    finalScoreLabel: 'Final score',
    playAgainButton: 'Play again',
    changeLookButton: 'Change look',
    recapLabel: 'How it went',
    statsWinRate: 'Win rate',
    statsTopMove: 'Most played',
    statsRounds: 'Rounds',
    shareButton: 'Copy result',
    shareCopied: 'Copied',
    shareFailed: 'Press to select, then copy',
    /** Ties are excluded from win rate, so say so rather than imply otherwise. */
    winRateAllTies: '—',
  },
  sound: {
    mute: 'Mute sound effects',
    unmute: 'Unmute sound effects',
  },
  theme: {
    label: 'Pick a look',
    selectedMark: '✓',
    selectedLabel: 'Selected',
  },
  nav: {
    /** Shown when leaving costs nothing (match already over). */
    backToHome: 'Back to home',
    /** Shown mid-match, where leaving forfeits the score. */
    leaveMatch: 'Leave match',
    confirmTitle: 'Leave this match?',
    confirmBody: 'The current score will be lost.',
    confirmLeave: 'Leave match',
    confirmStay: 'Keep playing',
  },
} as const;
