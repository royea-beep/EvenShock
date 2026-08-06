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
    icons/             Custom flat-fill SVG icons — fallback when a theme has no art
    screens/           Home, Round (picking → revealing → result), MatchEnd
    ChoiceButton.tsx   The choice button used during picking and in theme previews
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

`useGame()` exposes `playerChoice`, `botChoice`, `roundResult`, `score`, `format`, `matchStatus`, and the actions to pick a choice, start a match, advance past a round result, and play again. `App.tsx` derives which screen to show from that state alone — there's no separate screen state to keep in sync.

## Themes

Eight visual identities, picked on the Home screen before a match. Each is a complete identity: artwork, colors, page background, fonts, corner radii, shadow/glow, motion easing, and SFX character.

| Theme | `id` | Artwork |
| --- | --- | --- |
| Studio | `studio` | `set01_studio_hands` |
| Classical Marble | `marble` | `set03_marble` |
| Liquid Chrome | `chrome` | `set04_chrome` |
| X-Ray | `xray` | `set05_xray` |
| Macro Nature | `nature` | `set06_macro_nature` |
| Product Catalogue | `product` | `set07_product` |
| Zero Gravity | `zerog` | `set08_zerog` |
| Retro Pixel | `pixel` | — (SVG icons) |

The mechanism is `data-theme` + CSS custom properties. `useTheme()` writes one attribute onto `<html>`; the tokens cascade from there, so switching is instant, costs no React re-render, and can be scoped to any subtree — which is how the picker renders live previews of all eight themes on one page.

Retro Pixel deliberately ships **without** an art set. It's the one identity no photoreal render can produce, and it keeps the SVG icon path — which is also the image-load fallback — a real, exercised code path. An untested fallback is a broken fallback, so `themes.test.ts` asserts at least one theme stays art-free.

### Where the images live

```
src/assets/themes/<slug>/
  rock.webp          640px, shown at play size
  rock-thumb.webp    160px, shown in the theme picker (lazy-loaded)
  paper.webp   paper-thumb.webp
  scissors.webp  scissors-thumb.webp
```

42 files, **314 KB total** for all seven art sets. They're picked up by an `import.meta.glob` registry in `src/assets/themes/index.ts`, which only exposes a set once all six of its files are present — a half-populated folder is treated as absent, and that theme falls back to SVG rather than rendering a hole.

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

Every theme clears **WCAG AA (4.5:1)** for primary text, muted text, outcome colors, and choice-icon-on-fill — verified by measuring computed colors in a browser, not by eye. The current floor across all eight themes is 5.3:1. Outcomes carry a shape marker (▲ win / ▼ lose / ＝ tie) alongside the color and the wording, so they stay distinguishable without color perception. `prefers-reduced-motion` is respected in all eight, including the ones whose character is motion.

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
