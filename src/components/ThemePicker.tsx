import { useRef } from 'react';
import type { Choice } from '../types/game';
import { THEMES, type ThemeId } from '../constants/themes';
import { getImageSet } from '../assets/themes';
import { copy } from '../constants/copy';
import { ChoiceButton } from './ChoiceButton';

const PREVIEW_CHOICES: Choice[] = ['rock', 'paper', 'scissors'];

interface ThemePickerProps {
  theme: ThemeId;
  onChange: (theme: ThemeId) => void;
}

/**
 * A radiogroup of live theme previews. Each option is scoped with its own
 * `data-theme`, so the swatch inside renders the REAL choice buttons and the
 * REAL artwork under that theme's tokens — the pattern only works because the
 * Tailwind utilities are built with `@theme inline` and resolve through the
 * cascade at runtime.
 *
 * Previews use the 160px thumbnails and are lazy-loaded, so opening Home does
 * not pull the full-size art for seven themes at once.
 */
export function ThemePicker({ theme, onChange }: ThemePickerProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !back) return;

    event.preventDefault();
    const next = (index + (forward ? 1 : -1) + THEMES.length) % THEMES.length;
    onChange(THEMES[next].id);
    refs.current[next]?.focus();
  };

  return (
    <section className="w-full space-y-3">
      <p className="display-type text-center text-sm font-semibold text-muted">
        {copy.theme.label}
      </p>

      <div
        role="radiogroup"
        aria-label={copy.theme.label}
        className="flex flex-wrap items-stretch justify-center gap-3"
      >
        {THEMES.map((option, index) => {
          const selected = option.id === theme;
          const imageSet = getImageSet(option.imageSlug);
          return (
            <button
              key={option.id}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${option.name} — ${option.blurb}`}
              // Roving tabindex: one stop for the whole group, arrows move within.
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              data-theme={option.id}
              title={option.blurb}
              style={{
                borderRadius: 'var(--radius-md)',
                borderWidth: selected ? '3px' : 'var(--border-width)',
                borderColor: 'var(--border-color)',
                borderStyle: 'var(--border-style)',
                backgroundColor: 'var(--surface-card)',
                backgroundImage: 'var(--surface-page-image)',
                boxShadow: selected ? 'var(--shadow-card)' : undefined,
              }}
              className={`flex cursor-pointer flex-col items-center gap-2 p-2.5 transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current hover:scale-[1.03] ${
                selected ? 'scale-[1.03]' : 'opacity-85'
              }`}
            >
              <span className="flex items-center gap-1.5">
                {PREVIEW_CHOICES.map((choice) => (
                  <ChoiceButton key={choice} choice={choice} imageSet={imageSet} preview />
                ))}
              </span>

              <span
                aria-hidden="true"
                className="display-type theme-preview-label text-[0.68rem] font-bold text-ink"
              >
                {option.name}
              </span>

              {/* Selection is announced by aria-checked and marked with a glyph,
                  so it never relies on the highlight colour alone. */}
              <span className="text-[0.6rem] font-bold text-muted" aria-hidden="true">
                {selected ? copy.theme.selectedMark : ' '}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
