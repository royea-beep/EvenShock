import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { useGame } from './hooks/useGame';
import { useTheme } from './hooks/useTheme';
import { useThemeImages } from './hooks/useThemeImages';
import { useRoundHistory } from './hooks/useRoundHistory';
import { useMuted } from './hooks/useMuted';
import { useFastMode } from './hooks/useFastMode';
import { useAuth } from './hooks/useAuth';
import { useRounds } from './hooks/useRounds';
import { usePrefsMigration } from './hooks/usePrefsMigration';
import { getScreen } from './utils/getScreen';
import { unlockAudio } from './utils/sound';
import { HomeScreen } from './components/screens/HomeScreen';
import { RoundScreen } from './components/screens/RoundScreen';
import { MatchEndScreen } from './components/screens/MatchEndScreen';
import { MuteToggle } from './components/MuteToggle';
import { FastModeToggle } from './components/FastModeToggle';
import { LeaveMatchControl } from './components/LeaveMatchControl';
import { WalletButton } from './components/WalletButton';
import { RoundTrouble } from './components/RoundTrouble';
// TEMPORARY: impact-variant comparison. Delete with utils/impactVariant.ts.
import { ImpactVariantBadge } from './components/ImpactVariantBadge';
import { IMPACT_VARIANT } from './utils/impactVariant';

function App() {
  const auth = useAuth();
  // Rounds are resolved by the server for a signed-in player and by a local
  // draw for a guest — same interface, same async shape, same failure paths.
  // See useRounds: guest mode is not a second, simpler game.
  const rounds = useRounds(auth.status === 'authenticated');
  const game = useGame({ resolveOpponentChoice: rounds.resolveOpponentChoice });
  const screen = getScreen(game);
  const { muted, toggleMuted } = useMuted();
  const { fast, toggleFast, setFast } = useFastMode();
  const { theme, setTheme } = useTheme();
  const imageSet = useThemeImages(theme);
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

  const handleStart = () => {
    unlockAudio(); // warm the audio context from a real user gesture
    // Opens the match server-side and prefetches round 1 before the round
    // screen is even interactive.
    rounds.beginMatch(game.format, theme, fast);
    game.startMatch();
  };

  /** Leaving abandons the server-side match too: it stays in_progress, and the
   *  leaderboard counts only finalized matches. */
  const handleLeave = () => {
    rounds.reset();
    game.playAgain();
  };

  return (
    <>
      <MuteToggle muted={muted} onToggle={toggleMuted} />
      <FastModeToggle fast={fast} onToggle={toggleFast} />
      <WalletButton auth={auth} />
      <ImpactVariantBadge />

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
            {screen === 'home' && (
              <HomeScreen
                key="home"
                format={game.format}
                onFormatChange={game.setFormat}
                onStart={handleStart}
                theme={theme}
                onThemeChange={setTheme}
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
                score={game.score}
                matchWinner={game.matchWinner}
                format={game.format}
                history={history}
                // Straight into another match on the same theme and format.
                // startMatch already performs the full reset, which is also what
                // clears the derived history.
                onPlayAgain={handleStart}
                onChangeLook={handleLeave}
              />
            )}
          </AnimatePresence>
        </motion.div>
      </main>
    </>
  );
}

export default App;
