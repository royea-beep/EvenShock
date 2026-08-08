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
    icons/             Custom flat-fill SVG icons — the image-load fallback
    screens/           Home, Round (picking → revealing → result), MatchEnd
    ChoiceButton.tsx   The choice button used during picking
    MoveArt.tsx        Renders a move: themed image, or the SVG icon as fallback
    HandsFaceOff.tsx   The two hands: shake in unison, then snap to the reveal
    ThemePicker.tsx    Radiogroup of live, individually themed previews
    Confetti.tsx       Hand-rolled canvas burst for a match win
    MuteToggle.tsx     Persistent sound toggle
  assets/themes/       Per-theme WebP art sets + the import.meta.glob registry
  hooks/
    useGame.ts         Single source of truth for all match/round state and actions
    useTheme.ts        Active theme, persisted to localStorage, written to <html>
    useThemeImages.ts  Resolves + preloads the active theme's art set
    useMuted.ts        Mute state, persisted to localStorage
  utils/
    gameLogic.ts       Pure functions: round winner, tie rule, match-complete/winner checks
    getBotChoice.ts    The bot's move — isolated so it can be swapped for a real opponent
    getScreen.ts       Derives which screen to render from useGame's state
    sound.ts           Web Audio SFX, synthesized (no audio files shipped)
  constants/
    copy.ts            All user-facing strings (kept out of components for future i18n)
    themes.ts          The THEMES array — id, name, blurb, art-set slug
    gameConfig.ts      Reveal/beat timing constants
  styles/
    themes.css         One token block per theme, plus the canonical token list
    themes.test.ts     Token-parity and art-set-completeness tests
  types/
    game.ts            Shared types (Choice, MatchFormat, RoundOutcome, Score, ...)
  App.tsx              Wires useGame() to the three screens
scripts/
  build-theme-assets.mjs   PNG → WebP (full + thumbnail) art-set conversion
```

A round's picking, revealing, and result states are all **one** `RoundScreen`, deliberately. The two hands stay mounted across the whole reveal, so the moment of truth is a snap of the same elements rather than a cross-fade between two screens.

## Game feel

- **Reveal:** three ~220ms pumps ("Rock… Paper… Scissors…") with both hands shaking in unison, then a snap on "Shoot!". The bot renders a neutral `?` until the snap — its choice doesn't exist client-side until then, so it can't be read early — and the bot's slot renders no `<img>` element and issues no request while the `?` is showing, so there's no network signal to read either. Pick to outcome measures ~870ms in-browser, inside the ~1s budget.
- **Feedback:** green tint + winner scale-up on a win, red tint + a ~200ms page knock on a loss, neutral grey pulse on a tie, confetti on a match win, and a desaturated (not punishing) treatment on a match loss.
- **Sound:** short SFX synthesized at runtime with the Web Audio API — no audio files, nothing to preload, nothing sampled. The context is only created from a real user gesture, so nothing trips browser autoplay policies, and any failure degrades to silence rather than breaking the game. Mute persists in localStorage.
- **Accessibility:** `prefers-reduced-motion` drops the shake, the screen knock, the flashes and the confetti, leaving a plain crossfade. Every outcome is stated in text, so nothing depends on color alone.

## Match context

A status bar rides above every phase of a round in best-of-3 and best-of-5 — including while you are choosing, which is the moment the standing actually matters. It carries the round number, the score, the format, and a W/L/T trail of the match so far. Single rounds have no standing to track, so it stays hidden.

The match-end screen recaps the rounds, shows win rate (ties excluded from the denominator), rounds played and most-played move, offers a plain-text result to copy, and gives two exits: **Play again** (same look and format) and **Change look** (back to Home).

**Round history is derived in the UI layer, not stored in `useGame`.** Each `roundNumber` resolves exactly once, so watching for a completed round reconstructs the whole trail — see `utils/roundHistory.ts`, which is a pure reducer so the reset behaviour is testable without rendering. Keeping it out of `useGame` matters: the hook is the multiplayer seam, and every field added to it is a field a real backend has to reproduce.

The reset is exact rather than heuristic. `roundNumber === 1` with no pick and no result is reachable only from `startMatch()` or `playAgain()`, and cannot recur mid-match — a played round either still shows its result or has already advanced the round number, ties included. So a new match always starts with an empty trail, whichever way it began.

`useGame()` exposes `playerChoice`, `botChoice`, `roundResult`, `score`, `format`, `matchStatus`, and the actions to pick a choice, start a match, advance past a round result, and play again. `App.tsx` derives which screen to show from that state alone — there's no separate screen state to keep in sync.

## Themes

Four visual identities, picked on the Home screen before a match. Each is a complete identity: artwork, colors, page background, fonts, corner radii, shadow/glow, motion easing, and SFX character.

| Theme | `id` | Artwork | Set |
| --- | --- | --- | --- |
| Studio Photography | `studio` | `set01_studio_hands` | 28.7 KB |
| Classical Marble | `marble` | `set03_marble` | 29.8 KB |
| Ink Brush | `ink` | `set17_ink` | 112.5 KB |
| Molten Lava | `molten` | `set12_molten` | 78.2 KB |

The four are deliberately spread rather than four variations on a mood: **two light grounds and two dark, two photoreal and two stylised**. That spread is what keeps them apart at tile size — and it is why the two metals (Liquid Chrome, Mecha Robotic), which measured as the closest pair of the twelve, both went in the cut.

Keep the count a **multiple of four** — the picker is 2 columns on mobile and 4 from `sm` up, and anything else leaves a short row centred under a full one. `themes.test.ts` asserts it.

The mechanism is `data-theme` + CSS custom properties. `useTheme()` writes one attribute onto `<html>`; the tokens cascade from there, so switching is instant, costs no React re-render, and can be scoped to any subtree — which is how the picker renders live previews of all four themes on one page.

### The SVG fallback

No theme ships without art any more. Retro Pixel used to, on the argument that an untested fallback is a broken fallback — the argument was right, the remedy was not.

`MoveArt` has two fallback branches: `imageSet === null` (theme has no art) and `onError` (the image failed to load). Shipping an SVG-only theme exercised the first and **never** the second — which is the one that actually fires in production, on a flaky network or a blocked request. It bought coverage of the lesser path while implying coverage of the greater one.

Both are covered directly now: `MoveArt.test.ts` pins the resolution and the handler wiring, and the browser suite aborts every `.webp` request and asserts all four picker tiles fall back to SVG, the move buttons keep their accessible names, and a round still plays to an outcome.

### Where the images live

```
src/assets/themes/<slug>/
  rock.webp          640px, shown at play size
  rock-thumb.webp    320px, shown in the theme picker (lazy-loaded)
  paper.webp   paper-thumb.webp
  scissors.webp  scissors-thumb.webp
```

24 files, **249 KB total** for all four art sets. Only the selected theme's full-size art is fetched; Home costs the four rock thumbnails, **29 KB**. Those tiles render at 188px, so pulling full-size art for them instead would cost far more for no visible gain. They're picked up by an `import.meta.glob` registry in `src/assets/themes/index.ts`, which only exposes a set once all six of its files are present — a half-populated folder is treated as absent, and that theme falls back to SVG rather than rendering a hole.

Two details that are easy to undo by accident:

- `vite.config.ts` sets `assetsInlineLimit` so `.webp` is **never** base64-inlined. Without it Vite inlines the thumbnails (all under 4 KB) into the JS bundle, which makes `loading="lazy"` a no-op and charges every visitor for seven themes' previews up front.
- `useThemeImages` preloads all three moves **uniformly**. Preloading only what's needed would create a per-move timing signal that leaks the bot's choice before the snap.

### Adding a new theme

Three places to touch, nothing else:

1. **Artwork (optional)** — drop three 1:1 PNGs at `assets-src/rps/<slug>/{rock,paper,scissors}.png` and run `node scripts/build-theme-assets.mjs`. It writes the full-size and thumbnail WebPs into `src/assets/themes/<slug>/`. Per-set quality overrides live at the top of that script — the defaults posterise glow falloff and specular highlights, which is why X-Ray, Chrome and Zero Gravity are pinned higher. `assets-src/` is a scratch input directory and is not committed.
2. **`src/styles/themes.css`** — copy an existing `[data-theme='...']` block and give every token a new value. The canonical token list is documented in the comment at the top of that file. **Every theme must define every token**; a missing one resolves to an undefined variable and breaks silently, so `src/styles/themes.test.ts` asserts parity and will fail the build if you skip one. Sample the palette from the artwork itself and record the sampled hexes in a comment, as the existing blocks do.
3. **`src/constants/themes.ts`** — add `{ id, name, blurb, imageSlug }` to the `THEMES` array. The `id` must match the `data-theme` value; `imageSlug` must match the asset folder, or be `null` for an SVG-only theme.

Removing a theme is the same three deletions in reverse. The test suite fails on an art folder no theme references, so a half-removal can't sit unnoticed.

Two things worth knowing when authoring:

- Tailwind utilities are wired to the tokens with **`@theme inline`** in `src/index.css`. The `inline` is load-bearing: with a plain `@theme`, Tailwind resolves each value once against `:root` at build time, so utilities freeze on whichever theme came first and never react to a `data-theme` change.
- Motion and audio character live in CSS alongside everything else (`--motion-ease`, `--motion-scale`, `--audio-wave`, `--audio-base-freq`, `--audio-detune`) and are read into JS by `src/utils/themeTokens.ts` — Framer Motion needs a bezier array and the Web Audio engine needs a waveform. Authoring a theme stays a single-file job.

### Accessibility across themes

Every theme clears **WCAG AA (4.5:1)** for primary text, muted text, outcome colors, and choice-icon-on-fill — verified by measuring computed colors in a browser, not by eye. The current floor across all four themes is 4.87:1. Outcomes carry a shape marker (▲ win / ▼ lose / ＝ tie) alongside the color and the wording, so they stay distinguishable without color perception. `prefers-reduced-motion` is respected in all four, including the ones whose character is motion.

Artwork carries the move name as `alt` text; when a theme has no art set, the accessible name moves to a visually-hidden span beside the `aria-hidden` SVG, so the name survives the fallback without being announced twice.

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
