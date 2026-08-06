import { useState } from 'react';
import type { Choice } from '../types/game';
import type { ImageSet } from '../assets/themes';
import { CHOICE_ICONS } from './icons';
import { copy } from '../constants/copy';

interface MoveArtProps {
  choice: Choice;
  /** null for themes with no art set — renders the SVG icon instead. */
  imageSet: ImageSet | null;
  size: 'full' | 'thumb';
  /** Decorative use (picker previews): suppresses the accessible name. */
  decorative?: boolean;
  /** Defer offscreen previews. Never set for the active theme's art. */
  lazy?: boolean;
  className?: string;
  iconClassName?: string;
}

/**
 * Renders a move as artwork, falling back to the built-in SVG icon if the
 * theme has no art set OR the image fails to load — never an empty box.
 *
 * The accessible name is the MOVE ("Rock"), not the art direction, and it is
 * carried by whichever branch renders: `alt` on the image, a visually-hidden
 * label beside the (aria-hidden) icon. That keeps the name present in the
 * fallback state without double-announcing in the normal one.
 */
export function MoveArt({
  choice,
  imageSet,
  size,
  decorative,
  lazy,
  className = '',
  iconClassName = '',
}: MoveArtProps) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : imageSet?.[choice]?.[size];
  const label = copy.choices[choice];

  if (src) {
    return (
      <img
        src={src}
        alt={decorative ? '' : label}
        aria-hidden={decorative || undefined}
        loading={lazy ? 'lazy' : 'eager'}
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className={`h-full w-full object-cover select-none ${className}`}
      />
    );
  }

  const Icon = CHOICE_ICONS[choice];
  return (
    <>
      <Icon className={iconClassName} />
      {!decorative && <span className="sr-only">{label}</span>}
    </>
  );
}
