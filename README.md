# EvenShock

Rock, Paper, Scissors — a colorful, single-page web game against a bot opponent, built with React, Tailwind CSS, and Framer Motion.

## Running it

```bash
npm install
npm run dev
```

Then open the printed local URL (defaults to `http://localhost:5173`).

Other scripts:

```bash
npm run build    # type-check + production build to dist/
npm run preview  # serve the production build locally
npm run lint     # oxlint
```

## Project structure

```
src/
  components/
    icons/             Custom flat-fill SVG icons (Rock, Paper, Scissors)
    screens/           Home, Round (picking → revealing → result), MatchEnd
    ChoiceButton.tsx   Colored circular choice button used during picking
    HandsFaceOff.tsx   The two hands: shake in unison, then snap to the reveal
    Confetti.tsx       Hand-rolled canvas burst for a match win
    MuteToggle.tsx     Persistent sound toggle
  hooks/
    useGame.ts         Single source of truth for all match/round state and actions
    useMuted.ts        Mute state, persisted to localStorage
  utils/
    gameLogic.ts       Pure functions: round winner, tie rule, match-complete/winner checks
    getBotChoice.ts    The bot's move — isolated so it can be swapped for a real opponent
    getScreen.ts       Derives which screen to render from useGame's state
    sound.ts           Web Audio SFX, synthesized (no audio files shipped)
  constants/
    copy.ts            All user-facing strings (kept out of components for future i18n)
    palette.ts         Choice color tokens, mirrored in the Tailwind theme
    gameConfig.ts      Reveal/beat timing constants
  types/
    game.ts            Shared types (Choice, MatchFormat, RoundOutcome, Score, ...)
  App.tsx              Wires useGame() to the three screens
```

A round's picking, revealing, and result states are all **one** `RoundScreen`, deliberately. The two hands stay mounted across the whole reveal, so the moment of truth is a snap of the same elements rather than a cross-fade between two screens.

## Game feel

- **Reveal:** three ~220ms pumps ("Rock… Paper… Scissors…") with both hands shaking in unison, then a snap on "Shoot!". The bot renders a neutral `?` until the snap — its choice doesn't exist client-side until then, so it can't be read early. Pick to outcome is ~840ms.
- **Feedback:** green tint + winner scale-up on a win, red tint + a ~200ms page knock on a loss, neutral grey pulse on a tie, confetti on a match win, and a desaturated (not punishing) treatment on a match loss.
- **Sound:** short SFX synthesized at runtime with the Web Audio API — no audio files, nothing to preload, nothing sampled. The context is only created from a real user gesture, so nothing trips browser autoplay policies, and any failure degrades to silence rather than breaking the game. Mute persists in localStorage.
- **Accessibility:** `prefers-reduced-motion` drops the shake, the screen knock, the flashes and the confetti, leaving a plain crossfade. Every outcome is stated in text, so nothing depends on color alone.

`useGame()` exposes `playerChoice`, `botChoice`, `roundResult`, `score`, `format`, `matchStatus`, and the actions to pick a choice, start a match, advance past a round result, and play again. `App.tsx` derives which screen to show from that state alone — there's no separate screen state to keep in sync.

## Game rules

- Rock beats Scissors, Scissors beats Paper, Paper beats Rock.
- A tie does not count toward the score — both players immediately pick again. That rule lives as a single named flag, `TIES_COUNT_TOWARD_SCORE`, in `utils/gameLogic.ts`, so it's a one-line change if that behavior should ever differ.
- Match formats: Single Round, Best of 3, Best of 5 (first to the majority of wins).

## Designed for a future multiplayer swap

Right now the opponent's move comes from `utils/getBotChoice.ts` — pure `Math.random()` across the three choices. Nothing else in the app calls `Math.random()` or knows the opponent is a bot.

`useGame()` accepts an optional `resolveOpponentChoice` function (defaulting to `getBotChoice`):

```ts
useGame({ resolveOpponentChoice: getBotChoice }); // today
useGame({ resolveOpponentChoice: readOpponentMoveFromSupabase }); // later
```

That function can return a `Promise<Choice>`, so a real implementation can `await` a Realtime payload instead of resolving instantly — `useGame` already awaits the result before computing the round outcome, so no UI code needs to change.

`useGame`'s state is also already shaped like a future Supabase row: `playerChoice` / `botChoice` map to `player_choice` / `opponent_choice`, `matchStatus` maps to `status`, and `format` is `format` as-is. Lifting local state into a Realtime-backed `matches` table later should be a contained change to `useGame` and `getBotChoice`'s replacement, not a rewrite of the screens.

No backend, auth, or Supabase client is wired up in this version — that's deliberately out of scope for now.
