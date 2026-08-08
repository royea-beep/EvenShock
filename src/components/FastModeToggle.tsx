import { copy } from '../constants/copy';

interface FastModeToggleProps {
  fast: boolean;
  onToggle: () => void;
}

/**
 * Sits beside the mute toggle, because it is the same kind of thing: a standing
 * preference about how much production the player wants, not a game action.
 */
export function FastModeToggle({ fast, onToggle }: FastModeToggleProps) {
  const label = fast ? copy.pace.disable : copy.pace.enable;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={fast}
      aria-label={label}
      title={label}
      style={{
        borderRadius: 'var(--radius-themed-md)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
        boxShadow: 'var(--shadow-card)',
      }}
      className={`fixed right-4 top-[4.25rem] z-40 flex h-11 w-11 cursor-pointer items-center justify-center bg-elevated text-ink transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${
        fast ? '' : 'opacity-70'
      }`}
    >
      <BoltIcon filled={fast} />
    </button>
  );
}

function BoltIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path
        d="M13 2.5 5.5 13.5h5L11 21.5 18.5 10.5h-5L13 2.5z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
