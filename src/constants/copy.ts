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
  pace: {
    enable: 'Turn on fast rounds',
    disable: 'Turn off fast rounds',
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
  /**
   * Shown when a round cannot be settled. Every line names what happened to the
   * player's MOVE, because that is the thing they are worried about — a round
   * that hangs after you have committed feels like the game took something.
   */
  trouble: {
    retryingTitle: 'Still waiting',
    retryingBody: 'Your move is locked in. Reaching the server…',

    offlineTitle: "Can't reach the server",
    offlineBody: 'Your move is safe and this round is still open. Try again when you have signal.',
    offlineRetry: 'Try again',

    refusedTitle: 'This round has closed',
    refusedBody: 'It expired before your move arrived. Nothing was counted.',

    /**
     * A legitimate player cannot reach the rate limit — the animation alone
     * puts a floor of about a second on a round. So this wording assumes a bug
     * on our side rather than scolding someone who did nothing wrong.
     */
    rateLimitedTitle: 'Too many rounds too quickly',
    rateLimitedBody:
      "Play is paused for a moment. If you were playing normally, this shouldn't have happened — please tell us.",

    /** Deliberately blunt. This one means the server contradicted itself. */
    fairnessTitle: 'This result could not be verified',
    fairnessBody:
      'The server did not play the move it committed to before you chose. This match has been stopped and will not be counted. Please report it.',

    leaveMatch: 'Leave match',
  },

  /**
   * XP and chips. Every string here is virtual-currency wording and none of it
   * may imply money, price in a real currency, or a way to buy chips — that is
   * a different product with a different legal shape.
   */
  economy: {
    xpLabel: 'XP',
    chipsLabel: 'Chips',
    levelLabel: 'Level',

    /** Shown on the match-end screen, where the numbers actually change. */
    earned: 'Earned this match',

    /**
     * Guest labelling. Said plainly and up front, because the alternative is
     * someone discovering it after two hundred rounds.
     */
    guestTitle: 'Playing as a guest',
    guestBody: 'XP and chips are saved in this browser only. Clearing it clears them.',
    guestShort: 'This browser only',

    /**
     * Shown BEFORE the wallet dialog opens, never after. Guest progress is a
     * demo of the loop, not a credit — migrating it would mean anyone could
     * clear their browser, replay, and claim again.
     */
    connectNoticeTitle: 'Guest progress stays here',
    connectNoticeBody:
      'Connecting a wallet starts a fresh account. The XP and chips you earned as a guest stay in this browser and are not transferred.',
    connectNoticeConfirm: 'Connect anyway',
    connectNoticeCancel: 'Keep playing as guest',
  },

  shop: {
    /** Locked tiles say what they cost, in chips, in place. */
    priceLabel: (chips: number) => `${chips} chips`,
    locked: 'Locked',
    unlock: 'Unlock',
    unlocking: 'Unlocking…',
    owned: 'Unlocked',
    cannotAfford: 'Not enough chips yet — keep playing.',
    failed: "That didn't go through. Try again.",
  },
} as const;
