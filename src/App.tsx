import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { useGame } from './hooks/useGame';
import { useTheme } from './hooks/useTheme';
import { useThemeImages } from './hooks/useThemeImages';
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

      <motion.main
        animate={shakeControls}
        className="flex min-h-dvh items-center justify-center p-6"
      >
        {/* Home carries an eight-tile grid and wants the extra width; a round
            is two hands and a caption, which reads better held narrow. */}
        <div className={`w-full ${screen === 'home' ? 'max-w-3xl' : 'max-w-xl'}`}>
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
                onPlayAgain={game.playAgain}
              />
            )}
          </AnimatePresence>
        </div>
      </motion.main>
    </>
  );
}

export default App;
