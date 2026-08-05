interface IconProps {
  className?: string;
}

/** Bold flat-fill fist shape. */
export function RockIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true">
      <path
        d="M27 46c0-9 6-15 13-15 2-8 8-13 15-13s13 5 15 13c8 0 14 7 14 16v10c0 15-12 28-27 28h-3c-15 0-27-12-27-27V46z"
        fill="currentColor"
      />
      <path
        d="M40 47v-9M53 46v-9M66 47v-8"
        stroke="rgba(0,0,0,0.15)"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}
