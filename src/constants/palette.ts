import type { Choice } from '../types/game';

/**
 * Choice color tokens, mirrored from the Tailwind `@theme` block in
 * src/index.css (--color-rock / --color-paper / --color-scissors). Kept here
 * too because SVG icon fills and Framer Motion values need raw hex, not
 * Tailwind classes.
 */
export const CHOICE_COLORS: Record<Choice, { base: string; dark: string }> = {
  rock: { base: '#2d6cdf', dark: '#1e4fa8' },
  paper: { base: '#f2a900', dark: '#c78600' },
  scissors: { base: '#ff5c5c', dark: '#d63d3d' },
};
