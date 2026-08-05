import { AnimatePresence } from 'framer-motion';
import { useGame } from './hooks/useGame';
import { getScreen } from './utils/getScreen';
import { HomeScreen } from './components/screens/HomeScreen';
import { GameScreen } from './components/screens/GameScreen';
import { RoundResultScreen } from './components/screens/RoundResultScreen';
import { MatchEndScreen } from './components/screens/MatchEndScreen';

function App() {
  const game = useGame();
  const screen = getScreen(game);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-xl">
        <AnimatePresence mode="wait">
          {screen === 'home' && (
            <HomeScreen
              key="home"
              format={game.format}
              onFormatChange={game.setFormat}
              onStart={game.startMatch}
            />
          )}

          {screen === 'game' && (
            <GameScreen key="game" playerChoice={game.playerChoice} onPick={game.pickChoice} />
          )}

          {screen === 'roundResult' && game.playerChoice && game.botChoice && game.roundResult && (
            <RoundResultScreen
              key="roundResult"
              playerChoice={game.playerChoice}
              botChoice={game.botChoice}
              roundResult={game.roundResult}
              score={game.score}
              matchStatus={game.matchStatus}
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
    </main>
  );
}

export default App;
