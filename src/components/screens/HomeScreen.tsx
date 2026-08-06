import { motion } from 'framer-motion';
import type { MatchFormat } from '../../types/game';
import type { ThemeId } from '../../constants/themes';
import { copy } from '../../constants/copy';
import { ThemePicker } from '../ThemePicker';

const FORMATS: MatchFormat[] = ['single', 'bo3', 'bo5'];

interface HomeScreenProps {
  format: MatchFormat;
  onFormatChange: (format: MatchFormat) => void;
  onStart: () => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}

export function HomeScreen({
  format,
  onFormatChange,
  onStart,
  theme,
  onThemeChange,
}: HomeScreenProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="flex flex-col items-center gap-8 text-center"
    >
      <div className="space-y-3">
        <h1 className="display-type text-5xl font-extrabold text-ink sm:text-6xl">
          {copy.home.title}
        </h1>
        <p className="text-lg text-muted">{copy.home.subtitle}</p>
      </div>

      <div className="space-y-3">
        <p className="display-type text-sm font-semibold text-muted">
          {copy.home.formatLabel}
        </p>
        <div
          className="flex flex-wrap justify-center gap-2"
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
              className={`display-type cursor-pointer px-5 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${
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

      <ThemePicker theme={theme} onChange={onThemeChange} />

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
    </motion.div>
  );
}
