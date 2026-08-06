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
  matchEnd: {
    winnerBanner: {
      player: 'You won the match!',
      opponent: 'The bot won this time',
    } as Record<'player' | 'opponent', string>,
    finalScoreLabel: 'Final score',
    playAgainButton: 'Play again',
  },
  sound: {
    mute: 'Mute sound effects',
    unmute: 'Unmute sound effects',
  },
} as const;
