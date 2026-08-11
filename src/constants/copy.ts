import type { Choice, MatchFormat, RoundOutcome } from '../types/game';

/**
 * All UI copy lives here. Nothing user-facing should be a string literal in a
 * component — keeps this file the single place to translate later.
 */
export const copy = {
  /**
   * The front door. Two paths, stated in full, chosen deliberately.
   *
   * The bullets are the whole point of the screen: guest-by-default with a
   * caption meant nobody arriving at the site knew an account existed, let
   * alone what it unlocked. So each path lists what it actually gets, and the
   * guest path names its limit in the same breath rather than in a footnote —
   * the wallet path only sells itself honestly if the guest one is described
   * fairly.
   */
  entry: {
    title: 'How do you want to play?',
    subtitle: 'Pick once. You can switch whenever you like.',

    guestTitle: 'Play as guest',
    guestTagline: 'Start now, nothing to install.',
    guestBullets: [
      'The whole game against the bot',
      'XP, chips and every free look',
      'No account, no wallet, no sign-in',
    ],
    guestLimit: 'Progress is saved in this browser only — clearing it clears everything.',
    guestCta: 'Play as guest',

    walletTitle: 'Connect a wallet',
    walletTagline: 'An account that follows you.',
    walletBullets: [
      'XP and chips kept on the server, on any browser',
      'Buy chips and unlock the paid looks',
      'Play a friend with an invite code',
      'Free tables or chip stakes, winner takes the pot',
    ],
    walletLimit: 'Starts a fresh account — guest progress stays in this browser.',
    walletCta: 'Connect wallet',
    walletNeeds: 'Needs a wallet extension: Phantom or MetaMask.',
    walletConnecting: 'Connecting…',
    /** Tag on the bullets that describe something the server can do and the
     *  app cannot yet. Removed by flipping MULTIPLAYER_UI_ENABLED, not by
     *  editing the bullet — a promise should stop being provisional in one
     *  place. */
    soonTag: 'soon',

    /** Connecting can fail, and the door must not trap anyone when it does. */
    failedRejected: 'Sign-in was cancelled. You can still play as a guest.',
    failedNoWallet: 'No wallet extension found. Install one and reload — or play as a guest now.',
    failedError: (message: string) => `Sign-in failed: ${message}`,

    /** The way back in, next to the wallet button. */
    switchLink: 'Guest or wallet?',
    dismiss: 'Close',
  },

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

  /**
   * Stake tables. Every string here names the cut before anyone commits to
   * anything: a visible rake is respected and a discovered one is resented,
   * and the difference is entirely in whether the number appeared before or
   * after the player agreed to play.
   */
  stakes: {
    freeLabel: 'Free table',
    stakeLabel: (chips: number) => `${chips} chips`,

    /** Shown at CREATE, before the invite code is generated. */
    createNotice: (stake: number, pot: number, rake: number, payout: number) =>
      `You're putting up ${stake} chips. Pot ${pot} — winner takes ${payout}, house takes ${rake}.`,

    /** Shown at JOIN, before the seat is claimed. Same numbers, said again:
     *  the joining player never saw the create screen. */
    joinNotice: (stake: number, pot: number, rake: number, payout: number) =>
      `You're putting up ${stake} chips to sit down. Pot ${pot} — winner takes ${payout}, house takes ${rake}.`,
    joinConfirm: 'Sit down and post my stake',
    joinCancel: 'Not this time',

    /** The whole flow, on the win screen. The rake is a line item, not a
     *  silent difference between the pot and what arrived. */
    wonTitle: (payout: number) => `You won the pot: +${payout} chips`,
    wonBreakdown: (pot: number, rake: number, payout: number) =>
      `${pot} pot − ${rake} house = ${payout}`,
    lostTitle: (stake: number) => `You lost ${stake} chips`,
    lostBreakdown: (payout: number) => `Your opponent took the pot: ${payout} chips`,

    /** Void paths. Saying "no house cut" out loud matters — a refund that
     *  quietly matches the stake is indistinguishable from one that quietly
     *  does not. */
    refundedTitle: (stake: number) => `Stake returned: ${stake} chips`,
    refundedBody: 'That match did not finish, so both stakes came back in full. No house cut.',

    /** Refused BEFORE anything is posted. No debt, no negative balance. */
    cannotAffordTitle: "You can't cover that stake",
    cannotAffordBody: (stake: number, chips: number) =>
      `This table costs ${stake} chips to sit down and you have ${chips}. Win a few free games or top up, then come back.`,
    opponentCannotAfford:
      "Your opponent couldn't cover the stake, so nobody was charged and the table is open again.",

    /** The forfeit copy the design insists on: name the timeout, name the
     *  consequence, and do not imply a fault on our side. */
    forfeitRevealTitle: 'You ran out of time to reveal',
    forfeitRevealBody: (payout: number) =>
      `Your move was locked in but the reveal didn't reach us in time, so the round went to your opponent — and with it the pot of ${payout} chips.`,
    forfeitCommitTitle: 'You ran out of time to move',
    forfeitCommitBody: 'The round closed before your move arrived, so it went to your opponent.',
    wonByForfeitTitle: 'Your opponent ran out of time',
    wonByForfeitBody: (payout: number) => `The round went to you, and the pot: +${payout} chips.`,

    /** The treasury wallet is refused a seat server-side, at every stake
     *  including free. Say which account and why — a refusal that doesn't
     *  name its reason reads as a bug, which is exactly how this one was
     *  first reported. */
    treasuryTitle: 'This wallet runs the house',
    treasuryBody:
      "You're signed in with the treasury wallet, which collects the house cut. It can't also sit at a table — that would make the books unreadable. Sign in with a player wallet to play.",

    /** Chips are chips. Restated at the point the house starts earning. */
    noCashValue: 'Chips stay in the game. They have no cash value and cannot be withdrawn.',
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

  /**
   * Buying chips with USDC. This is the section — and the ONLY section — where
   * money is named. Chips are not currency, cannot be redeemed, and cannot be
   * transferred out; the wording keeps that one-way relationship visible.
   */
  chipsPurchase: {
    buyTitle: 'Get 100 chips',
    buyPrice: 'for $1 in USDC (devnet)',
    buyButton: 'Buy 100 chips',
    buyButtonBusy: 'Working…',

    tosTitle: 'Before your first purchase',
    tosBody:
      'Chips are in-game credit for EvenShock. They have no cash value, they cannot be redeemed for money, and they cannot leave your account. When you send USDC to buy them, that transaction is final — payments are not reversible.',
    tosCheckbox: 'I understand: chips are non-refundable, non-redeemable, and stay in my account.',
    tosContinue: 'I understand — continue',
    tosCancel: 'Not now',
    tosSaving: 'Saving…',

    resumeTitle: 'You have a purchase in progress',
    resumeBody:
      "You started a purchase earlier that hasn't finished. If you already sent the payment, we'll credit it as soon as it confirms — you can leave this page open or come back later.",
    resumePayNow: "I haven't paid yet — pay now",
    resumeCheckStatus: "I already paid — check status",
    resumeStartNew: 'Cancel that and start a new purchase',

    walletMissing: 'Chip purchases need a Solana wallet in this release.',
    walletBusy: 'Approve the transaction in your wallet…',
    walletRejected: 'You cancelled the payment in your wallet.',
    walletError: (why: string) => `Your wallet returned an error: ${why}`,

    sending: 'Sending payment…',
    pendingTitle: 'Waiting for the network',
    pendingBody: "Your payment is in — we're waiting for the network to confirm it. This usually takes a few seconds.",
    pendingSlowBody: "Your payment is safe — we'll credit it as soon as it confirms. You can close this page.",

    credited: (chips: number) => `Credited: +${chips} chips`,
    creditedClose: 'Close',

    /**
     * Two failures that look the same to the code and are completely different
     * to the person reading them.
     *
     * The first version of this said "our reconciler will find it and credit
     * you — nothing is lost" for both. That copy is right, and reassuring, and
     * was shown for a failure where the wallet never signed — so the player was
     * told their money was safe when they had not spent any. Reassurance about
     * a thing that did not happen reads as confusion, or as a system that does
     * not know what it did.
     *
     * The dividing line is the signature: before it, nothing moved and the
     * right advice is "try again"; after it, the transfer is on chain and
     * irreversible and the right advice is "leave it with us". Never offer a
     * retry after the money has gone — that is how someone pays twice.
     */
    /**
     * The connected wallet is the treasury. A real user hit this by signing in
     * as the treasury account and pressing Buy: the transfer would have been a
     * self-transfer, the chain would have recorded a zero delta, and
     * verification would have correctly refused it — after they had signed and
     * paid a network fee. The server now refuses to issue the intent at all,
     * so this is what they see instead, before anything costs them anything.
     */
    walletIsTreasuryTitle: 'This wallet cannot buy chips',
    walletIsTreasuryBody:
      "You're connected with the wallet that receives payments, so buying would just send USDC to itself — the network would record no payment and nothing could be credited. Connect a different wallet to buy chips.",

    failedTitleUnspent: 'Payment not started',
    failedBodyUnspent:
      "Nothing left your wallet and you haven't been charged — this failed before the transaction was signed. You can safely try again.",

    failedTitle: 'Payment sent but not yet verified',
    failedBody:
      "Your payment is on the blockchain and we couldn't match it to this purchase yet. Don't pay again — our reconciler scans for it and will credit you. Contact support if it hasn't landed in a few minutes.",
    failedClose: 'Close',
  },
} as const;
