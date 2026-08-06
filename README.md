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

## Themes

Five visual identities — Neon Arcade, Paper & Ink, Retro Pixel, Candy Pop, Cyber Terminal — picked on the Home screen before a match. Each is a complete identity: colors, page background, fonts, corner radii, shadow/glow, motion easing, and SFX character.

The mechanism is `data-theme` + CSS custom properties. `useTheme()` writes one attribute onto `<html>`; the tokens cascade from there, so switching is instant, costs no React re-render, and can be scoped to any subtree — which is how the picker renders live previews of all five themes on one page.

### Adding a new theme

Two places to touch, nothing else:

1. **`src/styles/themes.css`** — copy an existing `[data-theme='...']` block and give every token a new value. The canonical token list is documented in the comment at the top of that file. **Every theme must define every token**; a missing one resolves to an undefined variable and breaks silently, so `src/styles/themes.test.ts` asserts parity and will fail the build if you skip one.
2. **`src/constants/themes.ts`** — add `{ id, name, blurb }` to the `THEMES` array. The `id` must match the `data-theme` value.

Two things worth knowing when authoring:

- Tailwind utilities are wired to the tokens with **`@theme inline`** in `src/index.css`. The `inline` is load-bearing: with a plain `@theme`, Tailwind resolves each value once against `:root` at build time, so utilities freeze on whichever theme came first and never react to a `data-theme` change.
- Motion and audio character live in CSS alongside everything else (`--motion-ease`, `--motion-scale`, `--audio-wave`, `--audio-base-freq`, `--audio-detune`) and are read into JS by `src/utils/themeTokens.ts` — Framer Motion needs a bezier array and the Web Audio engine needs a waveform. Authoring a theme stays a single-file job.

### Accessibility across themes

Every theme clears **WCAG AA (4.5:1)** for primary text, muted text, outcome colors, and choice-icon-on-fill — verified by measuring computed colors in a browser, not by eye. Outcomes carry a shape marker (▲ win / ▼ lose / ＝ tie) alongside the color and the wording, so they stay distinguishable without color perception. `prefers-reduced-motion` is respected in all five, including the ones whose character is motion.

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
