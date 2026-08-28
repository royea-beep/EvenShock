import type { Choice, MatchFormat, RoundOutcome } from '../types/game';
// The brand is operator config, not a literal — see constants/brand.ts. A
// licensee changes one env var, not seven strings scattered through the copy.
import { BRAND_NAME } from './brand';

/**
 * All UI copy lives here. Nothing user-facing should be a string literal in a
 * component — keeps this file the single place to translate later.
 */
/** 1st, 2nd, 3rd, 4th… Used by the tournament result copy. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

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
    /** Shown ONLY on the very first visit, ABOVE the "How do you want to
     * play?" headline — explain first, ask second. Eyes skip middle
     * paragraphs sandwiched between a headline and cards, which is where
     * this used to sit.
     *
     * Two paragraphs and one compliance line, in that order: what the game
     * is; why a wallet matters and what chips are NOT (the no-cash-value
     * framing does the honest-selling and the compliance work in one
     * breath); and the 18+ line — there from day one, not retrofitted.
     *
     * Suppressed after the first visit via the entryIntroSeen storage flag —
     * a returning player who reopens the door via "Guest or wallet?" has
     * already answered "what is this", so we don't ask again.
     */
    intro: {
      headline: 'New here?',
      gameLine:
        `${BRAND_NAME} is rock-paper-scissors — quick matches against the bot or a friend, XP for playing, chips for winning.`,
      walletLine:
        'A wallet is optional. It keeps your progress on the server, on any browser, and unlocks buying chips — chips have no cash value, they buy cosmetic looks and nothing you can cash out.',
      adultLine: 'Chip purchases are for adults 18 and over.',
    },
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
    // Ordered by pull, strongest first: a friend is the hook, persistence is
    // the practical case, purchases come last. The stake-tables line that
    // used to end this list is GONE, not tagged "soon": stakes are flag-off
    // pending counsel with no date attached, and a public screen advertising
    // wagering money-bought chips — even provisionally — is the exact
    // exposure the flag exists to avoid. The line returns when the flag
    // flips and counsel has cleared the copy, not before.
    walletBullets: [
      'Play a friend with an invite code',
      'XP and chips kept on the server, on any browser',
      'Buy chips and unlock the paid looks',
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

  /**
   * Playing a friend. Every state a player can be in has a sentence here,
   * including the ones that go badly — a forfeit that reads as a generic
   * "match expired" is the difference between a game and a grievance.
   */
  versus: {
    entry: 'Play a friend',
    title: 'Play a friend',
    subtitle: 'One of you makes a table, the other types the code.',

    createHeading: 'Make a table',
    formatLabel: 'Length',
    stakeLabel: 'Stake',
    freeStake: 'Free',
    createButton: 'Make the table',
    creating: 'Making it…',

    joinHeading: 'Join a table',
    codePlaceholder: 'Invite code',
    joinButton: 'Join',
    joining: 'Joining…',

    /** The waiting room. The code is the whole screen — it is the one thing
     *  the player has to get to another human. */
    waitingTitle: 'Waiting for your friend',
    waitingBody: 'Send them this code. The table stays open for 10 minutes.',
    copyCode: 'Copy code',
    copied: 'Copied',

    /** In-round. "They have moved" is never shown, because the server never
     *  says it — knowing would be a free option on your own move. */
    yourMove: 'Make your move',
    committedTitle: 'Move locked in',
    committedBody: 'Neither of you can see the other until both have moved.',
    revealingTitle: 'Revealing…',
    revealingBody: 'Both moves are in. Settling the round.',

    roundLabel: (n: number) => `Round ${n}`,
    scoreLabel: 'Score',
    youLabel: 'You',
    themLabel: 'Them',

    wonRound: 'You win the round',
    lostRound: 'You lose the round',
    tiedRound: 'A tie — go again',

    /** Forfeits, named. Which one happened is not a detail. */
    forfeitTheirs: 'They ran out of time',
    forfeitYours: 'You ran out of time',
    voidRound: 'Nobody moved in time — the round was voided',

    nextRound: 'Next round',
    leave: 'Leave',
    finish: 'Done',
    backToLobby: 'Back',

    /** The one that must never be quiet: the server contradicted itself. */
    unverifiedTitle: 'That result could not be verified',
    unverifiedBody:
      "The move revealed doesn't match what was locked in before the round. The match has been stopped and nothing was accepted.",

    errors: {
      table_unavailable: 'That code is not a table you can join.',
      insufficient_chips: "You can't cover that stake.",
      wallet_is_treasury: 'The treasury wallet cannot sit at a table.',
      bad_stake: 'That stake is not on offer.',
      rate_limited: 'Slow down a moment, then try again.',
      network: "That didn't reach us. Try again.",
    } as Record<string, string>,
    errorFallback: 'Something went wrong with that table.',
  },

  home: {
    title: BRAND_NAME,
    subtitle: 'Rock. Paper. Scissors. Outsmart the bot.',
    formatLabel: 'Choose a format',
    startButton: 'Start game',
    leaderboardButton: 'Leaderboard',
    tournamentsButton: 'Tournaments',

    /**
     * The opponent picker.
     *
     * Both blurbs say what the opponent DOES, because the difference between
     * them is the whole feature and a player who picks Nemesis without knowing
     * it reads them will just think the game got unfair. "Some of the time" is
     * load-bearing: it is 35%, and a player who assumes it reads every round
     * will misread their own blind losses as being predicted.
     */
    opponentLabel: 'Choose an opponent',
    opponents: {
      random: 'Random',
      nemesis: 'Nemesis',
    } as Record<string, string>,
    opponentBlurbs: {
      random: 'Throws at random, every round. Nothing to read, nothing reading you.',
      nemesis: 'Watches how you throw and plays the counter — some of the time.',
    } as Record<string, string>,
  },
  leaderboard: {
    title: 'Leaderboard',
    subtitle: 'Ranked by wins. Only finalized matches count.',
    close: 'Close',
    loading: 'Loading the board…',
    error: (message: string) => `Couldn't load the board: ${message}`,
    emptyBoard: (n: number) =>
      `No qualifying players yet — play ${n} completed matches to be the first.`,
    qualifyHint: (n: number) =>
      `Play ${n} more completed ${n === 1 ? 'match' : 'matches'} to appear on the board.`,
    /** ------------------------------------------------------ the rated ladder
     *
     * A separate board from the activity table below it, and the distinction
     * is not cosmetic: the ladder counts HEAD-TO-HEAD matches only, because
     * those are the ones that carry a skill signal. Solo results are excluded
     * on purpose — the bot draws uniformly, and against a uniform opponent
     * every strategy has identical expected value. Measured, not assumed: the
     * blind branch sits at q=0.46 with 0.50 inside the interval. Ranking
     * players by solo wins would be ranking them by luck.
     */
    ladderTitle: 'Ladder',
    ladderSubtitle: 'Rated on matches against other people.',
    yourStanding: 'Your standing',
    /** Cold start, said plainly rather than showing a blank row. */
    unrated: 'No rated matches yet — the ladder counts matches against another person, not the bot.',
    rankOf: (rank: number, total: number) => `#${rank} of ${total}`,
    ratingLabel: 'Rating',
    /** Movement is the reason a board is worth reopening. A zero delta reads as
     *  unchanged rather than "+0": a draw between matched players genuinely
     *  moves nothing, and dressing that up would make every other number here
     *  less believable. */
    movement: {
      up: (delta: number) => `+${delta} from your last match`,
      down: (delta: number) => `${delta} from your last match`,
      flat: 'Unchanged by your last match',
    },
    /** The activity table. Retitled honestly: it counts completed matches
     *  including solo ones, so it measures how much someone plays, not how
     *  well. It is not the ladder and should not be read as one. */
    activityTitle: 'Most active',
    activitySubtitle: 'Completed matches, including against the bot. Activity, not skill.',

    notOnBoard:
      'You have played enough to qualify, but your row is outside the top 100.',
    youTag: '(you)',
    headers: {
      rank: '#',
      player: 'Player',
      wins: 'Wins',
      played: 'Played',
      winRate: 'Win %',
    },
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
    /** The acquisition act, on the screen where a player has something to
     *  send. Names the outcome ("beat this") rather than the mechanism
     *  ("create a table"), because the mechanism is not what motivates. */
    challengeFriend: 'Challenge a friend to beat this',
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
      `Chips are in-game credit for ${BRAND_NAME}. They have no cash value, they cannot be redeemed for money, and they cannot leave your account. When you send USDC to buy them, that transaction is final — payments are not reversible.`,
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

    /**
     * Paying with a token other than USDC. The swap is routed so the treasury
     * still receives USDC; the player sees the cost in the token they hold.
     * Two rules for this copy: the guaranteed number is the one promised
     * ("at least N chips" — never a number the swap could undercut), and an
     * expired quote must say plainly that nothing was charged, because
     * "expired" next to a payment flow reads as "my money vanished".
     */
    tokenPickerLabel: 'Pay with',
    tokenUsdcLabel: 'USDC',
    quoting: 'Getting a price…',
    quoteTitle: (sym: string) => `Pay with ${sym}`,
    // ExactOut: the input is bounded, the chips are exact.
    quoteLineExactOut: (input: string, sym: string, chips: number) =>
      `Up to ${input} ${sym} for ${chips} chips`,
    // ExactIn: the input is exact, the chips have a guaranteed floor.
    quoteLineExactIn: (input: string, sym: string, minChips: number) =>
      `${input} ${sym} for at least ${minChips} chips`,
    quoteExplainer:
      "The swap settles at the market price when it lands. You'll never get fewer chips than shown here — if the price moves too far, the whole payment fails and you keep your tokens.",
    quoteCountdown: (secs: number) => `Price valid for ${secs}s`,
    quotePay: 'Pay now',
    quoteRefresh: 'Refresh price',
    quoteExpiredTitle: 'That price expired',
    quoteExpiredBody:
      'Prices are only held for a minute, and this one lapsed before you signed. Nothing was charged and nothing left your wallet. Refresh to see the current price.',
    swapUnavailableTitle: 'Token payments unavailable right now',
    swapUnavailableBody:
      "We couldn't price that token — the swap service isn't reachable. You haven't been charged. Buying with USDC directly still works.",
    swapUnavailableNote: 'Other tokens are unavailable right now — USDC still works.',
    solFeeNote: 'Paying in SOL keeps a little back for network fees.',
  },

  /**
   * Tournaments. The same rule as `stakes` above and for the same reason: the
   * cost appears BEFORE the commitment, never after it.
   *
   * The one line that is easy to leave out and matters most is `poolLine`. A
   * tournament pool has NO house cut — every chip collected goes back out to
   * first and second. Staying silent about that would be hiding good news, but
   * it would also leave a player who has read the stake-table copy assuming a
   * rake that is not there, and a player who assumes a hidden cut is a player
   * who has stopped believing the numbers.
   */
  tournaments: {
    title: 'Tournaments',
    empty: 'No tournaments are open right now. Check back soon.',
    close: 'Back',

    entrants: (n: number, max: number) => `${n}/${max} players`,
    entryFree: 'Free to enter',
    entryFee: (chips: number) => `${chips} chips to enter`,
    pool: (chips: number) => `${chips} chip prize pool`,

    /** Shown on the confirm step, before a single chip moves. */
    joinTitle: 'Enter this tournament?',
    joinNotice: (fee: number, pool: number, entrants: number, max: number) =>
      `Entering costs ${fee} chips. That goes straight into the prize pool, which is ${pool} chips with ${entrants} of ${max} players in.`,
    joinFreeNotice: (entrants: number, max: number) =>
      `This one is free to enter. ${entrants} of ${max} players are in.`,
    poolLine:
      'The whole pool is paid out — 65% to the winner, 35% to the runner-up. The house takes nothing from a tournament.',
    joinConfirm: (fee: number) => (fee > 0 ? `Pay ${fee} chips and enter` : 'Enter'),
    joinCancel: 'Not this time',
    joining: 'Entering…',

    /** Why the button is not there. A disabled control with no reason reads as
     *  a bug — this is the same lesson as the treasury-seat copy. */
    blocked: {
      already_entered: "You're in this one.",
      not_registering: 'Entry has closed.',
      full: 'This one is full.',
      unrateable_player: 'This account cannot enter tournaments.',
      insufficient_chips: "You can't cover the entry fee.",
    } as Record<string, string>,

    /** The bracket. */
    bracketTitle: 'Bracket',
    seed: (n: number) => `#${n}`,
    bye: 'Bye',
    waiting: 'Waiting',
    tbd: 'To be decided',
    won: 'Won',
    playNow: 'Play your match',
    opening: 'Opening…',
    yourMatchReady: "It's your turn — your opponent is waiting.",
    waitingOnOthers: 'Waiting on other matches to finish.',
    knockedOut: 'You were knocked out. You can still watch the rest.',

    /** The end. Modelled on the pot screen: show the arithmetic, not just the
     *  arrival, and say the house cut out loud even when it is zero. */
    resultTitle: 'Tournament complete',
    champion: (name: string) => `${name} takes it`,
    wonTitle: (prize: number) => `You won ${prize} chips`,
    runnerUpTitle: (prize: number) => `Runner-up: ${prize} chips`,
    placedTitle: (position: number) => `You finished ${ordinal(position)}`,
    breakdown: (pool: number, paid: number, prize: number, net: number) =>
      `Pool ${pool} − house 0 = ${pool} paid out. You put in ${paid} and took ${prize} — net ${net >= 0 ? '+' : ''}${net} chips.`,
    noPrize: (paid: number) =>
      `You put in ${paid} chips and did not place. The pool went to the top two in full.`,
  },

  /**
   * NEMESIS — the debrief.
   *
   * The point of this opponent is not that it wins more. It is that afterwards
   * the player finds out WHY, in numbers they could have counted themselves.
   * So every line here describes something that actually happened rather than
   * offering advice: the situation Nemesis watched, the counts it saw, and how
   * the rounds split between read and blind.
   *
   * TWO LINES ARE HONESTY OBLIGATIONS, not flavour:
   *
   *   `blindNote` — the blind rounds were genuinely blind. This game does not
   *   stage losses to keep anyone sweet, and saying so is what lets a player
   *   believe they out-played it rather than being let through.
   *
   *   `trophyCaveat` — a perfect predictability score means "unreadable", and a
   *   player using an external randomiser genuinely is unreadable. That is the
   *   theorem working, not an exploit, and it is not defended against. But it
   *   does mean the trophy measures "did you use a dice" as much as skill, so
   *   the copy says that out loud rather than letting a perfect score imply
   *   something it hasn't earned.
   */
  nemesis: {
    title: 'What Nemesis saw',

    /** Cold start, stated rather than hidden — see nemesis_config.ramp_start_rounds. */
    calibrating: (roundsLeft: number) =>
      `Nemesis is still learning you — ${roundsLeft} more ${roundsLeft === 1 ? 'round' : 'rounds'}. Until then it throws blind, every round.`,

    readLabel: 'Rounds it read you',
    blindLabel: 'Rounds it threw blind',
    splitLine: (read: number, blind: number) =>
      `It read you on ${read} of ${read + blind} ${read + blind === 1 ? 'round' : 'rounds'}.`,
    wonOf: (won: number, of: number) => `you won ${won} of ${of}`,
    blindNote:
      'The blind rounds were blind. Nothing is thrown away to keep a match close — when you win one of those, you won it.',

    tellTitle: 'Your tell',
    /**
     * The situation the lens was watching, as a sentence opener. `prevMove`
     * arrives already labelled (`copy.choices[...]`) rather than as the raw
     * move, so the two halves of the sentence never disagree about how a
     * choice is spelled.
     */
    situation: (prevOutcome: string | null, prevMove: string | null) => {
      const outcome =
        prevOutcome === 'win' ? 'winning' : prevOutcome === 'lose' ? 'losing' : 'tying';
      if (prevOutcome && prevMove) return `After ${outcome} a round having thrown ${prevMove}`;
      if (prevOutcome) return `After ${outcome} a round`;
      return `After you threw ${prevMove}`;
    },
    /** The conditional lenses: something happened, then the player answered. */
    tellSentence: (situation: string, move: string, count: number, total: number) =>
      `${situation}, you followed with ${move} ${count} ${count === 1 ? 'time' : 'times'} out of ${total}.`,
    /** The marginal lens, which is not conditional on anything and must not be
     *  worded as though it were. */
    tellOverall: (move: string, count: number, total: number) =>
      `Across every round, you threw ${move} ${count} ${count === 1 ? 'time' : 'times'} out of ${total}.`,
    noTell:
      "It never found a lean worth playing this match. It threw blind because there was nothing to read.",

    predictabilityTitle: 'How readable you are',
    predictabilityValue: (percent: number) => `${percent}%`,
    trend: {
      down: (before: number, after: number) => `Down from ${before}% to ${after}% — harder to read than you were.`,
      up: (before: number, after: number) => `Up from ${before}% to ${after}% — easier to read than you were.`,
      flat: (after: number) => `Steady at ${after}%.`,
    },
    predictabilityPending:
      'Not enough rounds yet to say how readable you are.',
    trophyTitle: 'Least readable yet',
    trophyCaveat:
      "0% means nothing in your throws predicted the next one. A dice would score that too — this measures how unreadable you were, not how you got there.",
  },
} as const;
