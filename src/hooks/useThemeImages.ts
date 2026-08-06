import { useEffect, useMemo } from 'react';
import { getImageSet, type ImageSet } from '../assets/themes';
import { themeImageSlug, type ThemeId } from '../constants/themes';
import type { Choice } from '../types/game';

const MOVES: Choice[] = ['rock', 'paper', 'scissors'];

/**
 * Resolves the active theme's art set and warms the browser cache for it.
 *
 * All THREE moves are preloaded together, unconditionally, as soon as the theme
 * is chosen on Home. That is deliberate on two counts:
 *  - the reveal never stalls or pops part-way through the snap, and
 *  - there is no per-move timing signal. Fetching only the bot's actual choice
 *    at reveal time would leak it over the network; fetching all three up front,
 *    before any pick exists, cannot.
 */
export function useThemeImages(theme: ThemeId): ImageSet | null {
  const imageSet = useMemo(() => getImageSet(themeImageSlug(theme)), [theme]);

  useEffect(() => {
    if (!imageSet) return;
    // Held only for the duration of the fetch; the browser cache is the product.
    const pending = MOVES.map((move) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = imageSet[move].full;
      return img;
    });
    return () => {
      for (const img of pending) img.src = '';
    };
  }, [imageSet]);

  return imageSet;
}
