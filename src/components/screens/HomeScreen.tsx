import { motion } from 'framer-motion';
import type { MatchFormat } from '../../types/game';
import type { ThemeId } from '../../constants/themes';
import { copy } from '../../constants/copy';
import { ThemePicker, type ThemeShop } from '../ThemePicker';
import { BalanceStrip } from '../BalanceStrip';
import { ChipsShop } from '../ChipsShop';
import type { Purchase } from '../../hooks/usePurchase';

const FORMATS: MatchFormat[] = ['single', 'bo3', 'bo5'];

interface HomeScreenProps {
  format: MatchFormat;
  onFormatChange: (format: MatchFormat) => void;
  onStart: () => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  /** XP and chips. Omitted before the first read lands. */
  economy: { xp: number; chips: number; persistent: boolean; loading: boolean };
  /** Absent when nothing is locked — see ThemePicker. */
  shop?: ThemeShop;
  /** Chip purchase flow. Absent for guests — they never see the buy path. */
  chipsShop?: Purchase;
  /**
   * Opens the friend match. Absent for guests, and absent entirely while the
   * multiplayer flag is off — the prop being undefined is the enforcement, so
   * there is no button to find with a screen inspector.
   */
  onPlayFriend?: () => void;
}

export function HomeScreen({
  format,
  onFormatChange,
  onStart,
  theme,
  onThemeChange,
  economy,
  shop,
  chipsShop,
  onPlayFriend,
}: HomeScreenProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      // Explicit tween — the framer default spring for a mixed opacity+y
      // transition landed around 650ms with visible wobble at settle, and its
      // shape differed per property, which made HomeScreen and MatchEndScreen
      // feel like they used slightly different transitions. easeOutQuint over
      // 280ms per direction (~560ms total with mode="wait") is crisper than the
      // default spring and unifies the three screens so every AnimatePresence
      // swap feels like the same gesture. The 280ms sits inside the top of the
      // "heavy content" range — long enough that a photographic screen doesn't
      // read as a cut, short enough that it isn't sluggish.
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      // Deliberate vertical rhythm instead of even gaps: the masthead is one
      // block, and the two choices below it are a tighter pair, so the screen
      // reads as composed top-down rather than floating in the middle.
      className="flex flex-col items-center gap-7 text-center sm:gap-9"
    >
      <div className="space-y-1.5">
        {/* "EvenShock" is a single unbreakable word, so a fixed type size
            overflows narrow screens in the wide letter-spaced display faces
            (Marble, Chrome, X-Ray, Product) — measured spilling ~60px past a
            320px viewport at text-5xl. Scaling with the viewport up to the old
            size keeps every theme inside the page. */}
        <h1 className="display-type text-[clamp(2.15rem,10.5vw,4rem)] leading-[0.95] font-extrabold text-ink sm:text-7xl">
          {copy.home.title}
        </h1>
        <p className="text-base text-muted sm:text-lg">{copy.home.subtitle}</p>
      </div>

      <div className="w-full space-y-3">
        <p className="display-type text-sm font-semibold text-muted">
          {copy.home.formatLabel}
        </p>
        {/* A 3-column grid rather than flex-wrap. Label width varies wildly
            between themes — the letter-spaced uppercase faces make "Single
            Round" roughly twice the width it is in Studio — so a wrapping flex
            row broke into a ragged 2+1 on narrow screens in some themes and not
            others. Equal thirds keep the three formats on one row in every
            theme; a long label wraps inside its own pill instead. */}
        <div
          // Capped well inside Home's width: the theme grid wants all 768px,
          // but three format pills stretched that far read as a toolbar.
          className="mx-auto grid max-w-md grid-cols-3 items-stretch gap-1.5 sm:gap-2"
          role="radiogroup"
          aria-label={copy.home.formatLabel}
        >
          {FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={format === f}
              onClick={() => onFormatChange(f)}
              style={{
                borderRadius: 'var(--radius-themed-md)',
                borderWidth: 'var(--border-width)',
                borderColor: 'var(--border-color)',
                borderStyle: 'var(--border-style)',
              }}
              // Tighter type and padding on mobile so all three formats stay on
              // one row. The widest themes (Chrome, X-Ray, Product) set a
              // letter-spaced uppercase display face, which pushes "Single
              // Round" wide enough to wrap the group at text-sm/px-5.
              className={`display-type cursor-pointer px-2.5 py-2.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current sm:px-5 sm:text-sm ${
                format === f
                  ? 'bg-scissors text-scissors-ink'
                  : 'bg-elevated text-ink hover:opacity-80'
              }`}
            >
              {copy.formats[f]}
            </button>
          ))}
        </div>
      </div>

      {/* Directly under the masthead, above the choices: the balance is the
          reason the shop below it means anything, and for a guest the line
          saying where it lives has to be seen before any of it is earned. */}
      <BalanceStrip
        xp={economy.xp}
        chips={economy.chips}
        persistent={economy.persistent}
        loading={economy.loading}
      />

      {/* Guests never see the buy path — chipsShop is undefined for them.
          The prop absence is the enforcement: the component simply isn't
          rendered, so there's nothing to defeat with a screen inspector. */}
      {chipsShop && <ChipsShop purchase={chipsShop} />}

      <ThemePicker theme={theme} onChange={onThemeChange} shop={shop} />

      <motion.button
        type="button"
        onClick={onStart}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        style={{
          borderRadius: 'var(--radius-themed-md)',
          boxShadow: 'var(--shadow-card)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
        }}
        className="display-type cursor-pointer bg-scissors px-10 py-4 text-lg font-bold text-scissors-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
      >
        {copy.home.startButton}
      </motion.button>

      {/* Second, quieter than Start: the bot game is what a visitor came for,
          and the friend match is what they stay for. */}
      {onPlayFriend && (
        <button
          type="button"
          onClick={onPlayFriend}
          style={{
            borderRadius: 'var(--radius-themed-md)',
            borderWidth: 'var(--border-width)',
            borderColor: 'var(--border-color)',
            borderStyle: 'var(--border-style)',
          }}
          className="display-type -mt-4 min-h-11 cursor-pointer bg-elevated px-8 text-sm font-bold text-ink hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {copy.versus.entry}
        </button>
      )}
    </motion.div>
  );
}
