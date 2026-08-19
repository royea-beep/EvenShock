import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { useGame } from './hooks/useGame';
import { useTheme } from './hooks/useTheme';
import { useThemeImages } from './hooks/useThemeImages';
import { useRoundHistory } from './hooks/useRoundHistory';
import { useMuted } from './hooks/useMuted';
import { useFastMode } from './hooks/useFastMode';
import { useAuth } from './hooks/useAuth';
import { useRounds } from './hooks/useRounds';
import { useEconomy } from './hooks/useEconomy';
import { usePurchase } from './hooks/usePurchase';
import { usePrefsMigration } from './hooks/usePrefsMigration';
import { useEntryChoice } from './hooks/useEntryChoice';
import { getScreen } from './utils/getScreen';
import { THEMES } from './constants/themes';
import { isPricedTheme, matchAward } from './utils/economy';
import { unlockAudio } from './utils/sound';
import { installLatencyProbe } from './utils/latency';
import { HomeScreen } from './components/screens/HomeScreen';
import { RoundScreen } from './components/screens/RoundScreen';
import { MatchEndScreen } from './components/screens/MatchEndScreen';
import { MuteToggle } from './components/MuteToggle';
import { FastModeToggle } from './components/FastModeToggle';
import { FAST_MODE_ENABLED } from './constants/features';
import { LeaveMatchControl } from './components/LeaveMatchControl';
import { WalletButton } from './components/WalletButton';
import { EntryDoor } from './components/screens/EntryScreen';
import { VersusScreen } from './components/screens/VersusScreen';
import { useMultiplayer } from './hooks/useMultiplayer';
import { MULTIPLAYER_UI_ENABLED } from './constants/features';
import { RoundTrouble } from './components/RoundTrouble';
import { LeaderboardPanel } from './components/LeaderboardPanel';
import { TournamentsPanel } from './components/TournamentsPanel';
import { useTournaments } from './hooks/useTournaments';
import { TOURNAMENTS_UI_ENABLED } from './constants/features';
import { usePersistence } from './hooks/usePersistence';
import { useNemesis } from './hooks/useNemesis';
import { readInviteCodeFromUrl } from './utils/share';
import { NEMESIS_UI_ENABLED } from './constants/features';
import type { Opponent } from './types/game';
// TEMPORARY: impact-variant comparison. Delete with utils/impactVariant.ts.
import { ImpactVariantBadge } from './components/ImpactVariantBadge';
import { IMPACT_VARIANT } from './utils/impactVariant';

function App() {
  const auth = useAuth();
  // Rounds are resolved by the server for a signed-in player and by a local
  // draw for a guest — same interface, same async shape, same failure paths.
  // See useRounds: guest mode is not a second, simpler game.
  // `auth.resolved` matters here and nowhere else so far: crash-resume must not
  // treat the bootstrap window as "guest" and throw away a signed-in player's
  // committed round. See resumeDecision in useRounds.
  const rounds = useRounds(auth.status === 'authenticated', auth.resolved);
  const game = useGame({ resolveOpponentChoice: rounds.resolveOpponentChoice });
  const screen = getScreen(game);
  const { muted, toggleMuted } = useMuted();
  const { fast, toggleFast, setFast } = useFastMode();
  const { theme, setTheme } = useTheme();
  const imageSet = useThemeImages(theme);
  // Balances follow identity: connecting a wallet re-reads the ACCOUNT's
  // balance rather than carrying a guest one across. See useEconomy.
  const economy = useEconomy(auth.status === 'authenticated', theme);
  // A credited purchase must move the header balance immediately, so the
  // hook fires this callback and we re-read from the server. Nothing local
  // is added — the server's number is the one that counted.
  const purchase = usePurchase({
    authenticated: auth.status === 'authenticated',
    onCredited: economy.refresh,
  });
  // Playing a friend. Signed-in only — a table needs an identity on both
  // sides, and this is the first feature that is meaningless without one, so
  // guest mode is not bent to allow it.
  const mp = useMultiplayer(auth.status === 'authenticated');
  const persistence = usePersistence(auth.status === 'authenticated');
  // Tournaments. Signed-in only, like the friend match it is built on: a
  // bracket slot is an mp table, and an mp table needs an identity on both
  // sides. The panel renders at App level for the same reason the leaderboard
  // does — it must survive a screen change without unmounting.
  const tournaments = useTournaments(auth.status === 'authenticated');
  // Leaderboard open/closed. State lives here (not in HomeScreen) so it
  // remains reachable during a mid-match check without unmounting the panel
  // when the screen changes — and because the panel renders at App level,
  // above every screen, same pattern as the entry door.
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  // Which solo opponent the next match is against. Home state rather than
  // useGame state: useGame is the multiplayer seam and knows only how to ask
  // for a move, so who is answering is not its business. It is deliberately
  // NOT persisted — the pick is a decision about the next match, and a player
  // returning tomorrow should meet the choice again rather than a remembered
  // one they cannot remember making.
  const [opponent, setOpponent] = useState<Opponent>('random');
  // The debrief. Signed-in only and flag-gated for the same reason the picker
  // is: a guest's rounds are drawn in this browser, so there is nothing to
  // report on.
  const nemesisEnabled =
    NEMESIS_UI_ENABLED && auth.status === 'authenticated';
  const nemesis = useNemesis(nemesisEnabled);
  // The front door. Asked once, remembered, reopenable from the wallet button.
  // It renders OVER a mounted, playable app rather than in front of it — see
  // EntryScreen: if it fails, the game is what's left.
  const entry = useEntryChoice(auth.status);
  // Derived in the UI layer, deliberately: useGame stays the multiplayer seam.
  const history = useRoundHistory(game);
  const reducedMotion = useReducedMotion();

  // NOTE: `usePersistence` is read-only now and nothing renders history yet, so
  // it is not called here. Matches are written by the `play` Edge Function,
  // which is also the only thing that decides outcomes — the client holds no
  // INSERT grant on `matches` or `rounds`, so there is no write path to keep.

  // On first sign-in: copy localStorage prefs to profiles for columns that
  // are null, and apply profile prefs to app state for columns that aren't.
  // One-shot per session — see usePrefsMigration for the rules.
  usePrefsMigration({
    auth,
    theme,
    format: game.format,
    fast,
    setTheme,
    setFormat: game.setFormat,
    setFast,
  });

  /**
   * Arriving on ?invite=CODE opens the friend surface immediately.
   *
   * THE RECIPIENT IS THE SCARCE SIDE of an invite, so their path is the one
   * worth shortening: the link now lands them on the join screen with the code
   * already filled, rather than on a home screen they have to read and
   * navigate. VersusScreen still does the prefill and still does NOT auto-join
   * — pressing the button is one tap, and auto-joining would race the
   * wallet-connect flow and hand a legitimate invite a `table_full` refusal.
   *
   * Signed-in only, because a table needs an identity on both sides. A guest
   * who follows an invite sees the entry door first, which is the correct
   * order — and the code survives in the URL until they get here.
   */
  const invitedOpened = useRef(false);
  useEffect(() => {
    if (invitedOpened.current) return;
    if (!MULTIPLAYER_UI_ENABLED || auth.status !== 'authenticated') return;
    if (!readInviteCodeFromUrl()) return;
    invitedOpened.current = true;
    mp.open();
  }, [auth.status, mp]);

  // `window.evenshockLatency()` returns the submit round-trip summary, so
  // anyone testing on a real device can read p50/p95 without collecting console
  // lines by hand.
  useEffect(installLatencyProbe, []);

  const shakeControls = useAnimationControls();
  const shakenRound = useRef<number | null>(null);

  // The round that ends the match is the only one that earns the full payoff.
  // matchStatus flips to 'complete' in the same commit the outcome arrives, so
  // this is known exactly when the impact plays.
  const deciding = game.matchStatus === 'complete';

  // The impact knock, and a small push-in with it.
  //
  // Both live on the inner container, never on <main>: main spans the whole
  // viewport, so translating it pushed 6px of horizontal scroll on every
  // knocked round — invisible at rest and only caught by sampling the reveal
  // frame by frame. This container sits inside main's 24px padding.
  //
  // The shake is gated to deciding rounds and suppressed under reduced motion.
  // It and the white flash were the two elements most likely to grate by the
  // twentieth view, so they fire roughly once a match rather than once a round.
  useEffect(() => {
    if (!game.roundResult || reducedMotion || fast) return;
    if (shakenRound.current === game.roundNumber) return;
    shakenRound.current = game.roundNumber;

    if (deciding && game.roundResult !== 'tie') {
      // TEMPORARY: impact-variant branching. See utils/impactVariant.ts.
      //   a — current: single-axis knock + subtle push-in
      //   b — hit-stop: no shake (the freeze in HandsFaceOff replaces it)
      //   c — cinematic: no shake (a film beat, not a game beat)
      //   d — crush: heavier multi-axis knock over a longer window
      if (IMPACT_VARIANT === 'b' || IMPACT_VARIANT === 'c') return;

      if (IMPACT_VARIANT === 'd') {
        void shakeControls.start({
          x: [0, -18, 15, -12, 9, -5, 0],
          y: [0, 6, -5, 8, -3, 2, 0],
          scale: [1, 1.04, 1.015, 1.02, 1, 1],
          transition: { duration: 0.5, ease: 'easeInOut' },
        });
        return;
      }
      void shakeControls.start({
        x: [0, -10, 9, -6, 4, 0],
        scale: [1, 1.02, 1.005, 1],
        transition: { duration: 0.32, ease: 'easeInOut' },
      });
      return;
    }
    if (game.roundResult === 'lose') {
      void shakeControls.start({
        x: [0, -4, 4, -2, 0],
        transition: { duration: 0.18, ease: 'easeInOut' },
      });
    }
  }, [game.roundResult, game.roundNumber, reducedMotion, fast, deciding, shakeControls]);

  /**
   * Fetch the next round's commitment while the player is reading, never while
   * they are waiting.
   *
   * The condition is "we are on the round screen and no move is committed yet",
   * which covers both the gap before the first pick and the result screen
   * between rounds. That is seconds of human reading time, so the commitment is
   * already in hand when the tap comes — and it is why a cold Edge Function
   * instance (~1.2s) delays starting a match instead of stalling a reveal.
   */
  useEffect(() => {
    if (game.matchStatus !== 'playing') return;
    if (game.playerChoice !== null) return;
    rounds.prefetch();
  }, [game.matchStatus, game.playerChoice, game.roundNumber, rounds]);

  /**
   * Settle the economy exactly once when a match finishes.
   *
   * De-duped on the history ARRAY REFERENCE, which only changes when a new
   * match starts — React strict mode fires effects twice and any nearby state
   * change would otherwise settle the same match again. For a signed-in player
   * that would be harmless (the server credits once, by idem_key, and this only
   * re-reads) but for a guest it would silently double the payout, and the two
   * paths must not differ in what they pay.
   */
  const settledRef = useRef<typeof history | null>(null);
  useEffect(() => {
    if (game.matchStatus !== 'complete') return;
    if (history.length === 0) return;
    if (settledRef.current === history) return;
    settledRef.current = history;

    economy.settleMatch(history.length, history.filter((e) => e.outcome === 'win').length);

    // The debrief, asked for once the match is finalized — `nemesis_match_report`
    // refuses while a match is in progress, and rightly: naming which rounds
    // were read is a live advantage before the last one is played. The match id
    // is read from the ref at this exact moment, which is the one moment it is
    // guaranteed to be the match that just ended.
    const matchId = rounds.currentMatchId();
    if (opponent === 'nemesis' && matchId) nemesis.load(matchId);
  }, [game.matchStatus, history, economy, rounds, opponent, nemesis]);

  const handleStart = () => {
    unlockAudio(); // warm the audio context from a real user gesture
    // Last match's debrief goes before this one opens, not when the next one
    // ends: the match-end screen unmounts on the way into a new match, and a
    // stale report surviving that transition would appear over the wrong match.
    nemesis.clear();
    // Opens the match server-side and prefetches round 1 before the round
    // screen is even interactive.
    rounds.beginMatch(game.format, theme, fast, nemesisEnabled ? opponent : 'random');
    game.startMatch();
  };

  /** Leaving abandons the server-side match too: it stays in_progress, and the
   *  leaderboard counts only finalized matches. */
  const handleLeave = () => {
    nemesis.clear();
    rounds.reset();
    game.playAgain();
  };

  return (
    <>
      <MuteToggle muted={muted} onToggle={toggleMuted} />
      {/* Frozen — see constants/features.ts. The hook already forces `fast` to
          false, so this only removes a control that could do nothing. */}
      {FAST_MODE_ENABLED && <FastModeToggle fast={fast} onToggle={toggleFast} />}
      <WalletButton
        auth={auth}
        guestHasProgress={!economy.persistent && (economy.state.xp > 0 || economy.state.chips > 0)}
        // "Switch later" lives where the wallet button already is, which is
        // where someone who chose guest will look when they wonder what they
        // turned down.
        onCompare={entry.reopen}
      />
      <ImpactVariantBadge />

      {entry.showEntry && (
        <EntryDoor
          onConnect={auth.connect}
          onGuest={entry.chooseGuest}
          onWalletChosen={entry.chooseWallet}
          // A first visit has no dismiss: the choice is the point. A reopened
          // comparison does — looking is not un-choosing.
          onDismiss={entry.choice !== null ? entry.dismiss : undefined}
          showIntro={entry.showIntro}
        />
      )}

      {leaderboardOpen && (
        <LeaderboardPanel
          persistence={persistence}
          currentUserId={auth.session?.user.id}
          // The "N more to qualify" hint is skipped for now — the economy
          // hook does not expose a matches-completed count and adding one
          // just for a hint isn't worth the plumbing. The panel falls back
          // to `notOnBoard` copy when the caller is above rank 100 or
          // below the qualify threshold.
          onClose={() => setLeaderboardOpen(false)}
        />
      )}

      {/* Tournaments. Pressing Play in the bracket opens that slot's mp table
          and hands the invite code straight to the friend-match flow — the
          panel closes and the versus screen owns every screen from there. Both
          players take the same route: mp_join_table returns `already_seated`
          for the one who created the table, so one call covers both sides. */}
      <TournamentsPanel
        tournaments={tournaments}
        onPlay={(inviteCode) => {
          tournaments.close();
          mp.open();
          mp.join(inviteCode);
        }}
      />

      {/* The only route back to Home. playAgain() resets matchStatus to `idle`,
          which getScreen maps to 'home', and deliberately keeps `format`. */}
      <RoundTrouble trouble={rounds.trouble} onRetry={rounds.retry} onLeave={handleLeave} />

      {screen !== 'home' && (
        <LeaveMatchControl
          onLeave={handleLeave}
          // Mid-match with points on the board, leaving costs something. On the
          // match-end screen it costs nothing, so don't ask.
          confirmFirst={screen === 'round' && game.score.player + game.score.opponent > 0}
        />
      )}

      {/* overflow-x-clip is defensive for the impact-variant D throw + shake:
          the loser flies to x=300% of the hand and the App-level shake peaks
          at 15px in X. HandsFaceOff already clips its own wrapper, but a
          scrollbar-width bulge showed up at 1920 in the timing-audit overflow
          probe. Clipping main is the belt-and-braces version and does nothing
          on other variants because they never move anything past this box. */}
      <main className="flex min-h-dvh items-center justify-center overflow-x-clip p-6">
        {/* Home carries an eight-tile grid and wants the extra width; the round
            screen runs full width so the reveal has a stage to cross, and
            constrains its own bar and caption internally.

            The loss shake lives on THIS element rather than on <main>. main
            spans the whole viewport, so translating it pushed 6px of horizontal
            scroll on every losing round — invisible until the reveal was
            sampled frame by frame. This container sits inside main's 24px
            padding, where a 6px knock has room to happen. */}
        <motion.div
          animate={shakeControls}
          className={`w-full ${
            screen === 'home' ? 'max-w-3xl' : screen === 'round' ? 'max-w-none' : 'max-w-xl'
          }`}
        >
          <AnimatePresence mode="wait">
            {/* The friend match takes over the whole surface while it is open.
                It sits ABOVE the solo screens rather than beside them because a
                player is in one match or the other, never both. */}
            {mp.active && (
              <VersusScreen
                key="versus"
                mp={mp}
                imageSet={imageSet}
                chips={economy.state.chips}
              />
            )}

            {!mp.active && screen === 'home' && (
              <HomeScreen
                key="home"
                format={game.format}
                onFormatChange={game.setFormat}
                onStart={handleStart}
                theme={theme}
                onThemeChange={setTheme}
                economy={{
                  xp: economy.state.xp,
                  chips: economy.state.chips,
                  persistent: economy.persistent,
                  loading: economy.loading,
                }}
                // The shop only exists once something is actually locked. With
                // everything owned this is undefined and the picker is exactly
                // what it was before there was a currency.
                shop={
                  THEMES.some((t) => isPricedTheme(t.id) && !economy.owns(t.id))
                    ? {
                        owns: economy.owns,
                        buy: economy.buy,
                        chips: economy.state.chips,
                        error: economy.buyError,
                      }
                    : undefined
                }
                // Guests never see chip purchases. This is the enforcement:
                // the prop is undefined for guests and HomeScreen doesn't
                // render the component at all.
                chipsShop={auth.status === 'authenticated' ? purchase : undefined}
                // The entry to the friend match. Absent for guests, and absent
                // entirely until the flag is on — a button that cannot work is
                // worse than no button.
                onPlayFriend={
                  MULTIPLAYER_UI_ENABLED && auth.status === 'authenticated' ? mp.open : undefined
                }
                // The leaderboard button. Guests never see it — the RPC is
                // authenticated-only, so a button that cannot work is worse
                // than no button. Same rule as onPlayFriend above.
                onOpenLeaderboard={
                  auth.status === 'authenticated' ? () => setLeaderboardOpen(true) : undefined
                }
                // Gated on BOTH flags: a tournament match is played as a
                // friend match, so a bracket without multiplayer would take an
                // entry fee for a game nobody could start.
                onOpenTournaments={
                  TOURNAMENTS_UI_ENABLED &&
                  MULTIPLAYER_UI_ENABLED &&
                  auth.status === 'authenticated'
                    ? tournaments.open
                    : undefined
                }
                // The opponent picker. Absent for guests and while the flag is
                // off — and for guests the reason is not just the grant: their
                // rounds are drawn locally, so Nemesis would be the uniform bot
                // wearing a name it had not earned.
                opponent={opponent}
                onOpponentChange={nemesisEnabled ? setOpponent : undefined}
              />
            )}

            {screen === 'round' && (
              <RoundScreen
                key="round"
                playerChoice={game.playerChoice}
                botChoice={game.botChoice}
                roundResult={game.roundResult}
                score={game.score}
                matchStatus={game.matchStatus}
                roundNumber={game.roundNumber}
                format={game.format}
                history={history}
                imageSet={imageSet}
                theme={theme}
                deciding={deciding}
                fast={fast}
                onPick={game.pickChoice}
                onContinue={game.continueFromResult}
              />
            )}

            {screen === 'matchEnd' && (
              <MatchEndScreen
                key="matchEnd"
                earned={matchAward(
                  history.length,
                  history.filter((e) => e.outcome === 'win').length,
                )}
                economy={{
                  xp: economy.state.xp,
                  chips: economy.state.chips,
                  persistent: economy.persistent,
                  loading: economy.loading,
                }}
                score={game.score}
                matchWinner={game.matchWinner}
                format={game.format}
                history={history}
                // Straight into another match on the same theme and format.
                // startMatch already performs the full reset, which is also what
                // clears the derived history.
                onPlayAgain={handleStart}
                onChangeLook={handleLeave}
                nemesisReport={nemesis.report}
                nemesisBest={nemesis.best}
                // Surfaced after EVERY match, win or lose: the end of a match
                // is the one moment a player has a result worth sending
                // someone. Absent for guests and while the flag is off, same
                // rule as everywhere else.
                onChallengeFriend={
                  MULTIPLAYER_UI_ENABLED && auth.status === 'authenticated'
                    ? () => { nemesis.clear(); mp.open(); }
                    : undefined
                }
              />
            )}
          </AnimatePresence>
        </motion.div>
      </main>
    </>
  );
}

export default App;
