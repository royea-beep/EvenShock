import { useRef, useState } from 'react';
import type { Choice } from '../types/game';
import { THEMES, type ThemeId } from '../constants/themes';
import { isPricedTheme, themePrice } from '../utils/economy';
import { getImageSet } from '../assets/themes';
import { copy } from '../constants/copy';
import { MoveArt } from './MoveArt';

/**
 * One move stands in for the whole set. Rock fills the frame in every set and
 * reads as a silhouette at tile size, where the open hand and the blades both
 * go thin and ambiguous.
 */
const REPRESENTATIVE_MOVE: Choice = 'rock';

/**
 * The label sits on the art, so its contrast can't depend on the artwork. This
 * scrim reaches 0.74 black behind the text band, which puts white type at 9:1
 * even over a pure-white photo — the same guarantee in all eight themes,
 * independent of what the image happens to be.
 */
const SCRIM = 'linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.74) 42%, rgba(0,0,0,0) 100%)';

/**
 * The shop, such as it is. Omit it entirely and the picker behaves exactly as
 * it did before there was a currency — which is also what happens once a player
 * owns everything, because a shop with nothing left to sell is just noise on a
 * screen people use to change their look.
 */
export interface ThemeShop {
  owns(sku: string): boolean;
  buy(sku: string): Promise<boolean>;
  /** Rendered on locked tiles so the goal is visible before it is reachable. */
  chips: number;
  error: string | null;
}

interface ThemePickerProps {
  theme: ThemeId;
  onChange: (theme: ThemeId) => void;
  shop?: ThemeShop;
}

/**
 * A radiogroup of live theme previews: 2 x 4 on mobile, 4 x 2 from `sm` up.
 * Eight tiles divide evenly into both, so no row is ever left orphaned.
 *
 * Each option is scoped with its own `data-theme`, so the tile renders under
 * that theme's tokens — the pattern only works because the Tailwind utilities
 * are built with `@theme inline` and resolve through the cascade at runtime.
 */
export function ThemePicker({ theme, onChange, shop }: ThemePickerProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const [buying, setBuying] = useState<string | null>(null);

  /**
   * A theme is locked only when there IS a shop and it is priced and unowned.
   * With no shop every theme is free, which is what keeps this component
   * unchanged for guests before they have played anything.
   */
  const isLocked = (id: string) => Boolean(shop) && isPricedTheme(id) && !shop!.owns(id);

  const handleUnlock = async (id: string) => {
    if (!shop || buying) return;
    setBuying(id);
    const bought = await shop.buy(id);
    setBuying(null);
    // Wearing what you just bought is the point of buying it.
    if (bought) onChange(id as ThemeId);
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    // Read the real column count off the grid rather than duplicating the
    // breakpoint in JS, so arrow keys move the way the tiles actually look.
    const columns = gridRef.current
      ? getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').length
      : 1;

    const step =
      event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowLeft' ? -1
      : event.key === 'ArrowDown' ? columns
      : event.key === 'ArrowUp' ? -columns
      : 0;

    if (step === 0) return;

    event.preventDefault();
    const next = (index + step + THEMES.length) % THEMES.length;
    // Focus always moves, so a locked tile is reachable and its price is
    // announced; selection only follows for a theme the player actually has.
    if (!isLocked(THEMES[next].id)) onChange(THEMES[next].id);
    refs.current[next]?.focus();
  };

  return (
    <section className="w-full space-y-4">
      <p className="display-type text-center text-sm font-semibold text-muted">
        {copy.theme.label}
      </p>

      <div
        ref={gridRef}
        role="radiogroup"
        aria-label={copy.theme.label}
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        {THEMES.map((option, index) => {
          const selected = option.id === theme;
          const imageSet = getImageSet(option.imageSlug);
          const locked = isLocked(option.id);
          const price = themePrice(option.id);
          const unlocking = buying === option.id;

          return (
            <button
              key={option.id}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              // The price belongs in the accessible name, not only in the badge:
              // a locked tile that just reads "Jade" gives a screen-reader user
              // no idea why tapping it does something different.
              aria-label={
                locked
                  ? `${option.name} — ${option.blurb}. ${copy.shop.locked}, ${copy.shop.priceLabel(price ?? 0)}.`
                  : `${option.name} — ${option.blurb}`
              }
              aria-disabled={locked || undefined}
              // Roving tabindex: one stop for the whole group, arrows move within.
              tabIndex={selected ? 0 : -1}
              onClick={() => (locked ? void handleUnlock(option.id) : onChange(option.id))}
              onKeyDown={(event) => handleKeyDown(event, index)}
              data-theme={option.id}
              title={option.blurb}
              style={{
                borderRadius: 'var(--radius-md)',
                borderWidth: selected ? '3px' : 'var(--border-width)',
                borderColor: 'var(--border-color)',
                borderStyle: 'var(--border-style)',
                boxShadow: selected ? 'var(--shadow-card)' : undefined,
              }}
              className={`group relative block cursor-pointer overflow-hidden transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current hover:scale-[1.03] ${
                selected ? 'scale-[1.03]' : ''
              }`}
            >
              <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-rock text-rock-ink">
                <MoveArt
                  choice={REPRESENTATIVE_MOVE}
                  imageSet={imageSet}
                  // Thumbnails, not full-size art. The tiles render at 188px,
                  // and pulling twelve 640px images for them cost 351KB on
                  // Home against 92KB this way. Thumbs are 320px, so they are
                  // still oversampled for the tile on a 1x screen.
                  size="thumb"
                  decorative
                  // Only the active theme's art is already in memory; the rest
                  // are deferred so opening Home doesn't pull eight images.
                  lazy={!selected}
                  iconClassName="h-1/2 w-1/2"
                />

                {/* Unselected tiles are veiled rather than made translucent: an
                    opacity on the button would fade the label along with the
                    art and quietly cost it its contrast. */}
                {!selected && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 bg-black/30 transition-colors group-hover:bg-black/10"
                  />
                )}

                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5"
                  style={{ backgroundImage: SCRIM }}
                />

                <span
                  aria-hidden="true"
                  className="display-type theme-preview-label absolute inset-x-0 bottom-0 px-1.5 pb-1.5 text-[0.7rem] leading-tight font-bold text-white"
                >
                  {option.name}
                </span>

                {/* A locked tile is dimmed further and carries its price. The
                    art stays visible on purpose: the thing being sold is the
                    look, so hiding it would be selling a closed box. */}
                {locked && (
                  <>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 bg-black/55 transition-colors group-hover:bg-black/40"
                    />
                    <span
                      aria-hidden="true"
                      style={{ borderRadius: 'var(--radius-sm)' }}
                      className="display-type absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--surface-elevated)] px-2 py-1 text-[0.65rem] font-bold whitespace-nowrap text-[var(--text-primary)]"
                    >
                      {unlocking ? copy.shop.unlocking : copy.shop.priceLabel(price ?? 0)}
                    </span>
                  </>
                )}

                {/* Selection is carried four ways — a glyph badge, a heavier
                    border, the veil lifting, and aria-checked — so it never
                    rests on colour alone. */}
                {selected && (
                  <span
                    aria-hidden="true"
                    style={{ borderRadius: 'var(--radius-sm)' }}
                    className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center bg-scissors text-sm font-black text-scissors-ink"
                  >
                    {copy.theme.selectedMark}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* Only ever shown in response to an attempt. A standing "you cannot
          afford things" message on a screen people use to change their look
          would be nagging, not information. */}
      {shop?.error && (
        <p role="status" className="text-center text-sm text-[var(--outcome-lose)]">
          {shop.error === 'insufficient_chips' ? copy.shop.cannotAfford : copy.shop.failed}
        </p>
      )}
    </section>
  );
}
