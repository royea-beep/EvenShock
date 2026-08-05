import { motion } from 'framer-motion';
import type { MatchFormat } from '../../types/game';
import { copy } from '../../constants/copy';

const FORMATS: MatchFormat[] = ['single', 'bo3', 'bo5'];

interface HomeScreenProps {
  format: MatchFormat;
  onFormatChange: (format: MatchFormat) => void;
  onStart: () => void;
}

export function HomeScreen({ format, onFormatChange, onStart }: HomeScreenProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="flex flex-col items-center gap-10 text-center"
    >
      <div className="space-y-3">
        <h1 className="text-5xl font-extrabold tracking-tight text-slate-800 sm:text-6xl">
          {copy.home.title}
        </h1>
        <p className="text-lg text-slate-500">{copy.home.subtitle}</p>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          {copy.home.formatLabel}
        </p>
        <div className="flex flex-wrap justify-center gap-2" role="radiogroup" aria-label={copy.home.formatLabel}>
          {FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={format === f}
              onClick={() => onFormatChange(f)}
              className={`rounded-full px-5 py-2.5 text-sm font-semibold transition-colors ${
                format === f
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {copy.formats[f]}
            </button>
          ))}
        </div>
      </div>

      <motion.button
        type="button"
        onClick={onStart}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="rounded-full bg-scissors px-10 py-4 text-lg font-bold text-white shadow-lg shadow-scissors/40"
      >
        {copy.home.startButton}
      </motion.button>
    </motion.div>
  );
}
