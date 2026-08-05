interface IconProps {
  className?: string;
}

/** Bold flat-fill open-scissors shape: two blades meeting at crossed loops. */
export function ScissorsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true">
      <path d="M46 50 78 22c3-2 7 1 6 5L58 55" fill="currentColor" />
      <path d="M46 50 78 78c3 2 7-1 6-5L58 45" fill="currentColor" />
      <circle cx="30" cy="34" r="12" fill="currentColor" />
      <circle cx="30" cy="34" r="5" fill="rgba(0,0,0,0.2)" />
      <circle cx="30" cy="66" r="12" fill="currentColor" />
      <circle cx="30" cy="66" r="5" fill="rgba(0,0,0,0.2)" />
      <path d="M38 38 60 50 38 62" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
