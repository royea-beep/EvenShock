interface IconProps {
  className?: string;
}

/** Bold flat-fill open-hand / flat-sheet shape. */
export function PaperIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true">
      <rect x="24" y="30" width="52" height="46" rx="12" fill="currentColor" />
      <path d="M32 22c0-4 4-8 8-8h20c4 0 8 4 8 8v10H32V22z" fill="currentColor" />
      <path
        d="M32 44h36M32 55h36M32 66h28"
        stroke="rgba(0,0,0,0.15)"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}
