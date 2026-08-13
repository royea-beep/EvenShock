import { Component, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { copy } from '../../constants/copy';
import { MULTIPLAYER_UI_ENABLED } from '../../constants/features';
import { WALLET_INSTALL, type ConnectResult } from '../../data/wallet';

/**
 * The front door: two paths, described in full, chosen deliberately.
 *
 * WHY IT EXISTS. Guest was the default and the only sign that anything else
 * existed was a caption under the balance. Someone arriving at the site had no
 * way to know there were accounts, chips or a friend to play — the wallet
 * button said "Connect wallet" and never said what for. This screen is the
 * whole answer to that: each path lists what it gets, and the guest path names
 * its limit next to its benefits rather than in a footnote.
 *
 * WHAT IT MUST NEVER DO. Stand between a visitor and the game. It renders
 * ABOVE an app that is already mounted and playable, and it is wrapped in
 * `EntryDoor`'s error boundary, so a throw anywhere inside it removes the door
 * and leaves guest play running underneath. There is no data fetch, no lazy
 * chunk and no await before first paint — the only asynchronous thing here is
 * the wallet connect the visitor asks for, and its failure keeps the door open
 * with the guest path still one click away.
 */

interface EntryScreenProps {
  /** Runs the wallet connect. Owned by the caller because it is the same flow
   *  the wallet button uses; this screen only reacts to the result. */
  onConnect: () => Promise<ConnectResult>;
  /** Records the guest path and closes. */
  onGuest: () => void;
  /** Records the wallet path once a connect succeeds. */
  onWalletChosen: () => void;
  /** Closes without recording — only offered when the visitor reopened this
   *  themselves. A first visit has no dismiss: the choice is the point. */
  onDismiss?: () => void;
  /** Shows a small "what this is" block above the two path cards. Only on
   *  the very first visit — the flag is owned by useEntryChoice so the
   *  once-per-browser rule is enforced in one place. */
  showIntro?: boolean;
}

type Phase = { kind: 'idle' } | { kind: 'connecting' } | { kind: 'failed'; message: string };

export function EntryScreen({ onConnect, onGuest, onWalletChosen, onDismiss, showIntro }: EntryScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // Escape closes only the reopened comparison. On a first visit there is
  // nothing to escape to — dismissing without choosing would leave the visitor
  // in guest mode without having said so, which is the state this screen exists
  // to end.
  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const connect = async () => {
    setPhase({ kind: 'connecting' });
    try {
      const r = await onConnect();
      if (r.kind === 'ok') {
        onWalletChosen();
        return;
      }
      setPhase({
        kind: 'failed',
        message:
          r.kind === 'rejected'
            ? copy.entry.failedRejected
            : r.kind === 'no-wallet'
              ? copy.entry.failedNoWallet
              : copy.entry.failedError(r.message),
      });
    } catch (e) {
      // connect() returns typed results rather than throwing, but a wallet
      // extension is third-party code in the call stack. A throw here must not
      // leave the button stuck on "Connecting…".
      setPhase({ kind: 'failed', message: copy.entry.failedError(String(e)) });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="entry-title"
      // A FIXED scrim, not a themed one. The first render of this screen used
      // `--surface-base` with `text-ink` over it, and in the default theme both
      // resolve dark — the heading was invisible. Every other surface here is
      // themed (the cards carry the theme's border, radius and shadow); the
      // scrim and the text directly on it are the two things that must contrast
      // in all seven themes, so they do not take part.
      //
      // 75%, not the 94% it launched at: the live game renders underneath and
      // SHOULD show through — it orients ("there is a game behind this door")
      // and it sells. Contrast holds at the worst case: even over a pure-white
      // backdrop the composite is ~rgb(71,71,74), which puts solid white text
      // at ~9:1 and white/70 at ~5.5:1 — both past AA — and every theme's real
      // backdrop is darker than that. The backdrop-blur is load-bearing here:
      // it keeps the game legible as shapes, not as competing text.
      className="fixed inset-0 z-50 overflow-y-auto bg-[rgba(10,10,14,0.75)] p-4 backdrop-blur-sm sm:p-8"
    >
      <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-3 sm:gap-6">
        {/* Explain first, ask second: on a first visit the "what is this"
            block sits ABOVE the question headline. Eyes skip middle paragraphs
            between a headline and cards, which is where this used to live. */}
        {showIntro && (
          <section
            aria-label={copy.entry.intro.headline}
            className="mx-auto max-w-xl space-y-1.5 rounded-md bg-white/5 p-3 text-xs text-white/80 shadow-inner sm:space-y-2 sm:p-4 sm:text-sm"
          >
            <p className="text-white/95">{copy.entry.intro.gameLine}</p>
            <p>{copy.entry.intro.walletLine}</p>
            <p className="text-[0.68rem] font-semibold tracking-wide text-white/70 uppercase sm:text-xs">
              {copy.entry.intro.adultLine}
            </p>
          </section>
        )}

        <div className="space-y-1 text-center">
          <h1
            id="entry-title"
            className="display-type text-[clamp(1.35rem,5.5vw,2.25rem)] leading-tight font-extrabold text-white"
          >
            {copy.entry.title}
          </h1>
          <p className="text-xs text-white/70 sm:text-base">{copy.entry.subtitle}</p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 sm:gap-4">
          <PathCard
            title={copy.entry.guestTitle}
            tagline={copy.entry.guestTagline}
            bullets={copy.entry.guestBullets.map((text) => ({ text, soon: false }))}
            limit={copy.entry.guestLimit}
            cta={copy.entry.guestCta}
            onPick={onGuest}
            tone="quiet"
          />

          <PathCard
            title={copy.entry.walletTitle}
            tagline={copy.entry.walletTagline}
            // The FIRST bullet is multiplayer (it leads because it is the
            // strongest hook). It describes something the server can already
            // do; if the app ever ships without the UI for it, it carries a
            // tag until MULTIPLAYER_UI_ENABLED flips — see constants/features.
            bullets={copy.entry.walletBullets.map((text, i) => ({
              text,
              soon: i === 0 && !MULTIPLAYER_UI_ENABLED,
            }))}
            limit={copy.entry.walletLimit}
            note={copy.entry.walletNeeds}
            cta={phase.kind === 'connecting' ? copy.entry.walletConnecting : copy.entry.walletCta}
            busy={phase.kind === 'connecting'}
            onPick={() => void connect()}
            tone="loud"
          />
        </div>

        {phase.kind === 'failed' && (
          <div
            role="alert"
            className="mx-auto max-w-md rounded-md bg-amber-100 p-3 text-center text-xs text-amber-900 shadow"
          >
            <p className="whitespace-pre-wrap break-words">{phase.message}</p>
            <p className="mt-2 flex justify-center gap-3">
              {WALLET_INSTALL.map((w) => (
                <a
                  key={w.name}
                  href={w.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold underline hover:text-black"
                >
                  {w.name}
                </a>
              ))}
            </p>
          </div>
        )}

        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="mx-auto cursor-pointer text-xs text-white/70 underline decoration-dotted hover:text-white"
          >
            {copy.entry.dismiss}
          </button>
        )}
      </div>
    </motion.div>
  );
}

// ------------------------------------------------------------------ one path

function PathCard({
  title,
  tagline,
  bullets,
  limit,
  note,
  cta,
  onPick,
  busy = false,
  tone,
}: {
  title: string;
  tagline: string;
  bullets: Array<{ text: string; soon: boolean }>;
  limit: string;
  note?: string;
  cta: string;
  onPick: () => void;
  busy?: boolean;
  /** `loud` is the wallet path. It is visually primary because it is the one
   *  nobody knew existed — not because guest is a lesser choice. */
  tone: 'quiet' | 'loud';
}) {
  return (
    <section
      style={{
        borderRadius: 'var(--radius-themed-md)',
        borderWidth: 'var(--border-width)',
        borderColor: 'var(--border-color)',
        borderStyle: 'var(--border-style)',
        boxShadow: 'var(--shadow-card)',
      }}
      className="flex flex-col gap-2 bg-elevated p-3.5 text-left sm:gap-3 sm:p-5"
    >
      <div className="space-y-1">
        <h2 className="display-type text-base font-bold text-ink sm:text-lg">{title}</h2>
        <p className="text-xs text-muted">{tagline}</p>
      </div>

      <ul className="flex-1 space-y-1 text-[0.82rem] text-ink sm:space-y-1.5 sm:text-sm">
        {bullets.map((b) => (
          <li key={b.text} className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-[0.35rem] block size-1.5 shrink-0 rounded-full bg-[var(--choice-scissors)]" />
            <span>
              {b.text}
              {b.soon && (
                <span className="ml-1.5 rounded-full bg-[var(--surface-base)] px-1.5 py-0.5 align-middle text-[0.6rem] font-semibold tracking-wide text-muted uppercase">
                  {copy.entry.soonTag}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {/* The limit sits with the benefits, in the same type size as the
          bullets' qualifier line — not smaller, not greyed into invisibility. */}
      <p className="text-[0.68rem] leading-snug text-muted sm:text-xs">{limit}</p>
      {note && <p className="text-[0.68rem] leading-snug text-muted sm:text-xs">{note}</p>}

      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        style={{
          borderRadius: 'var(--radius-themed-md)',
          borderWidth: 'var(--border-width)',
          borderColor: 'var(--border-color)',
          borderStyle: 'var(--border-style)',
        }}
        className={`display-type min-h-11 cursor-pointer px-4 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-wait ${
          tone === 'loud'
            ? 'bg-scissors text-scissors-ink hover:opacity-90'
            : 'bg-[var(--surface-base)] text-ink hover:opacity-80'
        }`}
      >
        {cta}
      </button>
    </section>
  );
}

// -------------------------------------------------------------- the boundary

/**
 * The floor: the game working.
 *
 * A front door that fails to render must not become a blank page in front of a
 * working game. This boundary catches anything the screen throws and renders
 * nothing, which leaves the visitor in exactly the state they were in before
 * this feature existed — guest play, wallet button in the corner. No choice is
 * recorded on failure: being asked again next load is the correct outcome, and
 * writing one on their behalf would be the app deciding for them.
 */
export class EntryDoor extends Component<EntryScreenProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // No telemetry endpoint for client errors yet; the console is what a
    // developer looking at a missing door will check first.
    console.error('[entry] front door failed to render, falling through to guest play', error);
  }

  render() {
    if (this.state.failed) return null;
    return <EntryScreen {...this.props} />;
  }
}
