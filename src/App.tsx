import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { useGame } from './hooks/useGame';
import { useTheme } from './hooks/useTheme';
import { useThemeImages } from './hooks/useThemeImages';
import { useRoundHistory } from './hooks/useRoundHistory';
import { useMuted } from './hooks/useMuted';
import { getScreen } from './utils/getScreen';
import { unlockAudio } from './utils/sound';
import { HomeScreen } from './components/screens/HomeScreen';
import { RoundScreen } from './components/screens/RoundScreen';
import { MatchEndScreen } from './components/screens/MatchEndScreen';
import { MuteToggle } from './components/MuteToggle';
import { LeaveMatchControl } from './components/LeaveMatchControl';

function App() {
  const game = useGame();
  const screen = getScreen(game);
  const { muted, toggleMuted } = useMuted();
  const { theme, setTheme } = useTheme();
  const imageSet = useThemeImages(theme);
  // Derived in the UI layer, deliberately: useGame stays the multiplayer seam.
  const history = useRoundHistory(game);
  const reducedMotion = useReducedMotion();

  const shakeControls = useAnimationControls();
  const shakenRound = useRef<number | null>(null);

  // A losing round gives the page a small, brief knock — "ouch", not a glitch.
  useEffect(() => {
    if (game.roundResult !== 'lose' || reducedMotion) return;
    if (shakenRound.current === game.roundNumber) return;
    shakenRound.current = game.roundNumber;
    void shakeControls.start({
      x: [0, -6, 6, -4, 4, 0],
      transition: { duration: 0.2, ease: 'easeInOut' },
    });
  }, [game.roundResult, game.roundNumber, reducedMotion, shakeControls]);

  const handleStart = () => {
    unlockAudio(); // warm the audio context from a real user gesture
    game.startMatch();
  };

  return (
    <>
      <MuteToggle muted={muted} onToggle={toggleMuted} />

      {/* The only route back to Home. playAgain() resets matchStatus to `idle`,
          which getScreen maps to 'home', and deliberately keeps `format`. */}
      {screen !== 'home' && (
        <LeaveMatchControl
          onLeave={game.playAgain}
          // Mid-match with points on the board, leaving costs something. On the
          // match-end screen it costs nothing, so don't ask.
          confirmFirst={screen === 'round' && game.score.player + game.score.opponent > 0}
        />
      )}

      <main className="flex min-h-dvh items-center justify-center p-6">
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
                onPlayAgain={game.startMatch}
                onChangeLook={game.playAgain}
              />
            )}
          </AnimatePresence>
        </motion.div>
      </main>
    </>
  );
}

export default App;
