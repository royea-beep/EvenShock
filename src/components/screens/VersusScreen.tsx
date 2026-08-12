import { useState } from 'react';
import { motion } from 'framer-motion';
import { copy } from '../../constants/copy';
import { ChoiceButton } from '../ChoiceButton';
import { MoveArt } from '../MoveArt';
import type { ImageSet } from '../../assets/themes';
import type { MatchFormat } from '../../types/game';
import type { MultiplayerState } from '../../hooks/useMultiplayer';
import type { RoundResult, Seat } from '../../data/multiplayer';
import { STAKE_TABLES_ENABLED } from '../../constants/features';

/**
 * The friend match, on screen.
 *
 * THE ONE RULE THIS FILE MUST NOT BREAK. Nothing here may render "your
 * opponent has moved". The server does not send it — `mp_state` answers only
 * "have I committed" and "have we both committed" — and the reason is not
 * privacy, it is game theory: knowing the opponent has already committed while
 * you have not turns your own move into a free option. If a future version of
 * this screen wants a "they're ready" dot, the answer is no.
 *
 * The choreography is borrowed rather than rebuilt: the same ChoiceButton, the
 * same MoveArt, the same face-off framing as the solo game. What it does NOT
 * borrow is useGame's countdown, because the wind-up runs before an opponent
 * is known and a two-human round cannot start its animation until both have
 * committed. That seam change is still owed; this screen states the wait
 * plainly instead of pretending to animate through it.
 */

const FORMATS: MatchFormat[] = ['single', 'bo3', 'bo5'];

const pill = {
  borderRadius: 'var(--radius-themed-md)',
  borderWidth: 'var(--border-width)',
  borderColor: 'var(--border-color)',
  borderStyle: 'var(--border-style)',
};

export function VersusScreen({
  mp,
  imageSet,
  chips,
}: {
  mp: MultiplayerState;
  imageSet: ImageSet | null;
  /** Current balance, so a stake the player cannot cover is refused before the
   *  server has to say no. The server still refuses — this is courtesy, not
   *  enforcement. */
  chips: number;
}) {
  const [format, setFormat] = useState<MatchFormat>('bo3');
  const [stake, setStake] = useState(0);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);

  const { phase } = mp;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="flex w-full flex-col items-center gap-6 text-center"
    >
      <div className="space-y-1">
        <h1 className="display-type text-[clamp(1.6rem,7vw,2.5rem)] leading-tight font-extrabold text-ink">
          {copy.versus.title}
        </h1>
        <p className="text-sm text-muted">{copy.versus.subtitle}</p>
      </div>

      {/* ------------------------------------------------------------ lobby */}
      {(phase.kind === 'lobby' || phase.kind === 'creating' || phase.kind === 'joining') && (
        <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
          <section style={pill} className="space-y-3 bg-elevated p-4 text-left">
            <h2 className="display-type text-base font-bold text-ink">
              {copy.versus.createHeading}
            </h2>

            <p className="text-xs font-semibold text-muted">{copy.versus.formatLabel}</p>
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={copy.versus.formatLabel}>
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={format === f}
                  onClick={() => setFormat(f)}
                  style={pill}
                  className={`display-type min-h-9 cursor-pointer px-2 text-[0.7rem] font-semibold ${
                    format === f ? 'bg-scissors text-scissors-ink' : 'bg-[var(--surface-base)] text-ink'
                  }`}
                >
                  {copy.formats[f]}
                </button>
              ))}
            </div>

            {/* The stake picker exists only when wagering is cleared. With
                STAKE_TABLES_ENABLED false this whole block is dead code Vite
                removes, so there is no control to find with dev tools — and
                loadStakeOptions returns the free table only regardless. */}
            {STAKE_TABLES_ENABLED && (
              <>
                <p className="text-xs font-semibold text-muted">{copy.versus.stakeLabel}</p>
                <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label={copy.versus.stakeLabel}>
                  {mp.stakes.map((s) => {
                    const affordable = s.stake <= chips;
                    return (
                      <button
                        key={s.stake}
                        type="button"
                        role="radio"
                        aria-checked={stake === s.stake}
                        disabled={!affordable}
                        onClick={() => setStake(s.stake)}
                        style={pill}
                        className={`display-type min-h-9 cursor-pointer px-1 text-[0.7rem] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                          stake === s.stake
                            ? 'bg-scissors text-scissors-ink'
                            : 'bg-[var(--surface-base)] text-ink'
                        }`}
                      >
                        {s.stake === 0 ? copy.versus.freeStake : s.stake}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {/* The rake as a line item, before anyone sits down. A visible cut
                is respected; a discovered one is not. */}
            {STAKE_TABLES_ENABLED && <StakeNotice stake={stake} stakes={mp.stakes} kind="create" />}

            <button
              type="button"
              onClick={() => mp.create(format, STAKE_TABLES_ENABLED ? stake : 0)}
              disabled={phase.kind === 'creating' || !mp.stakesLoaded}
              style={pill}
              className="display-type min-h-11 w-full cursor-pointer bg-scissors px-4 text-sm font-bold text-scissors-ink disabled:cursor-wait"
            >
              {phase.kind === 'creating' ? copy.versus.creating : copy.versus.createButton}
            </button>
          </section>

          <section style={pill} className="space-y-3 bg-elevated p-4 text-left">
            <h2 className="display-type text-base font-bold text-ink">{copy.versus.joinHeading}</h2>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder={copy.versus.codePlaceholder}
              aria-label={copy.versus.codePlaceholder}
              maxLength={8}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              style={pill}
              className="display-type w-full bg-[var(--surface-base)] px-3 py-2.5 text-center text-lg font-bold tracking-[0.3em] text-ink"
            />
            {/* The joining player never saw the create screen, so the stake is
                stated again where they commit to it — not once, upstream. */}
            <p className="text-xs leading-snug text-muted">{copy.stakes.noCashValue}</p>
            <button
              type="button"
              onClick={() => mp.join(code)}
              disabled={code.trim().length < 4 || phase.kind === 'joining'}
              style={pill}
              className="display-type min-h-11 w-full cursor-pointer bg-scissors px-4 text-sm font-bold text-scissors-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase.kind === 'joining' ? copy.versus.joining : copy.versus.joinButton}
            </button>
          </section>
        </div>
      )}

      {/* ---------------------------------------------------------- waiting */}
      {phase.kind === 'waiting' && (
        <section style={pill} className="w-full max-w-md space-y-3 bg-elevated p-5">
          <h2 className="display-type text-lg font-bold text-ink">{copy.versus.waitingTitle}</h2>
          <p
            className="display-type text-[clamp(1.8rem,9vw,2.75rem)] font-extrabold tracking-[0.25em] text-ink"
            aria-label={`Invite code ${phase.table.inviteCode ?? ''}`}
          >
            {phase.table.inviteCode}
          </p>
          <p className="text-xs text-muted">{copy.versus.waitingBody}</p>
          {phase.table.stake > 0 && (
            <p className="text-xs text-muted">
              {copy.stakes.createNotice(
                phase.table.stake,
                phase.table.pot,
                phase.table.rake,
                phase.table.payout,
              )}
            </p>
          )}
          <div className="flex justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(phase.table.inviteCode ?? '')
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
              style={pill}
              className="display-type min-h-10 cursor-pointer bg-[var(--surface-base)] px-4 text-xs font-semibold text-ink"
            >
              {copied ? copy.versus.copied : copy.versus.copyCode}
            </button>
            <button
              type="button"
              onClick={mp.close}
              style={pill}
              className="display-type min-h-10 cursor-pointer px-4 text-xs font-semibold text-muted"
            >
              {copy.versus.leave}
            </button>
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------- playing */}
      {phase.kind === 'playing' && phase.state.round && (
        <section className="w-full max-w-xl space-y-4">
          <Scoreline
            seat={phase.state.seat}
            score={phase.state.score}
            round={phase.state.round.roundNumber}
          />
          {phase.committed ? (
            <div style={pill} className="space-y-1 bg-elevated p-5">
              <p className="display-type text-base font-bold text-ink">
                {copy.versus.committedTitle}
              </p>
              <p className="text-xs text-muted">{copy.versus.committedBody}</p>
            </div>
          ) : (
            <>
              <p className="display-type text-sm font-semibold text-muted">
                {copy.versus.yourMove}
              </p>
              <div className="flex items-center justify-center gap-2 sm:gap-4">
                {(['rock', 'paper', 'scissors'] as const).map((c) => (
                  <ChoiceButton key={c} choice={c} imageSet={imageSet} onSelect={mp.choose} />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* -------------------------------------------------------- revealing */}
      {phase.kind === 'revealing' && (
        <section style={pill} className="w-full max-w-md space-y-1 bg-elevated p-5">
          <p className="display-type text-base font-bold text-ink">{copy.versus.revealingTitle}</p>
          <p className="text-xs text-muted">{copy.versus.revealingBody}</p>
        </section>
      )}

      {/* ----------------------------------------------------------- result */}
      {phase.kind === 'result' && (
        <ResultPanel result={phase.result} imageSet={imageSet} onNext={mp.next} />
      )}

      {/* ------------------------------------------------------------ error */}
      {phase.kind === 'error' && (
        <section style={pill} className="w-full max-w-md space-y-2 bg-elevated p-5">
          {phase.code === 'unverified' ? (
            <>
              <p className="display-type text-base font-bold text-ink">
                {copy.versus.unverifiedTitle}
              </p>
              <p className="text-xs leading-snug text-muted">{copy.versus.unverifiedBody}</p>
            </>
          ) : (
            <p className="text-sm text-ink">
              {copy.versus.errors[phase.code] ?? copy.versus.errorFallback}
            </p>
          )}
          <button
            type="button"
            onClick={mp.open}
            style={pill}
            className="display-type min-h-10 cursor-pointer bg-[var(--surface-base)] px-4 text-xs font-semibold text-ink"
          >
            {copy.versus.backToLobby}
          </button>
        </section>
      )}

      {phase.kind !== 'error' && phase.kind !== 'waiting' && (
        <button
          type="button"
          onClick={mp.close}
          className="cursor-pointer text-xs text-muted underline decoration-dotted hover:text-ink"
        >
          {copy.versus.leave}
        </button>
      )}
    </motion.div>
  );
}

function StakeNotice({
  stake,
  stakes,
  kind,
}: {
  stake: number;
  stakes: { stake: number; pot: number; rake: number; payout: number }[];
  kind: 'create' | 'join';
}) {
  const opt = stakes.find((s) => s.stake === stake);
  if (!opt || opt.stake === 0) return null;
  const text =
    kind === 'create'
      ? copy.stakes.createNotice(opt.stake, opt.pot, opt.rake, opt.payout)
      : copy.stakes.joinNotice(opt.stake, opt.pot, opt.rake, opt.payout);
  return <p className="text-xs leading-snug text-muted">{text}</p>;
}

function Scoreline({
  seat,
  score,
  round,
}: {
  seat: Seat;
  score: { a: number; b: number };
  round: number;
}) {
  const you = seat === 'a' ? score.a : score.b;
  const them = seat === 'a' ? score.b : score.a;
  return (
    <p className="display-type text-sm font-semibold text-muted">
      {copy.versus.roundLabel(round)} · {copy.versus.youLabel} {you} — {them}{' '}
      {copy.versus.themLabel}
    </p>
  );
}

function ResultPanel({
  result,
  imageSet,
  onNext,
}: {
  result: RoundResult;
  imageSet: ImageSet | null;
  onNext: () => void;
}) {
  const youWon = result.outcome === result.you;
  const tied = result.outcome === 'tie' || result.outcome === null;
  const forfeit = result.resolution === 'commit_timeout' || result.resolution === 'reveal_timeout';
  const voided = result.resolution?.startsWith('void') ?? false;

  const headline = voided
    ? copy.versus.voidRound
    : forfeit
      ? youWon
        ? copy.versus.forfeitTheirs
        : copy.versus.forfeitYours
      : tied
        ? copy.versus.tiedRound
        : youWon
          ? copy.versus.wonRound
          : copy.versus.lostRound;

  const matchOver = result.tableStatus === 'finished';
  const wonPot = matchOver && result.tableResult === result.you && result.stake > 0;

  return (
    <section style={pill} className="w-full max-w-md space-y-3 bg-elevated p-5">
      <p className="display-type text-lg font-bold text-ink">{headline}</p>

      {/* Both hands, when there were two. A forfeited round has only one. */}
      <div className="flex items-center justify-center gap-6">
        <Hand label={copy.versus.youLabel} move={result.yourMove} imageSet={imageSet} />
        <Hand label={copy.versus.themLabel} move={result.opponentMove} imageSet={imageSet} />
      </div>

      {/* The pot, itemised. The rake is a line, never a silent difference
          between what the pot was and what arrived. */}
      {wonPot && (
        <div className="space-y-0.5">
          <p className="display-type text-sm font-bold text-ink">
            {copy.stakes.wonTitle(result.payout)}
          </p>
          <p className="text-xs text-muted">
            {copy.stakes.wonBreakdown(result.pot, result.rake, result.payout)}
          </p>
        </div>
      )}
      {matchOver && result.tableResult !== result.you && result.stake > 0 && (
        <p className="text-xs text-muted">{copy.stakes.lostTitle(result.stake)}</p>
      )}
      {voided && result.stake > 0 && (
        <p className="text-xs text-muted">{copy.stakes.refundedBody}</p>
      )}

      <button
        type="button"
        onClick={onNext}
        style={pill}
        className="display-type min-h-11 w-full cursor-pointer bg-scissors px-4 text-sm font-bold text-scissors-ink"
      >
        {matchOver ? copy.versus.finish : copy.versus.nextRound}
      </button>
    </section>
  );
}

function Hand({
  label,
  move,
  imageSet,
}: {
  label: string;
  move: string | null;
  imageSet: ImageSet | null;
}) {
  return (
    <div className="space-y-1">
      <div className="flex h-16 w-16 items-center justify-center">
        {move ? (
          <MoveArt
            choice={move as 'rock' | 'paper' | 'scissors'}
            imageSet={imageSet}
            size="thumb"
            className="h-14 w-14"
          />
        ) : (
          <span className="text-2xl text-muted">—</span>
        )}
      </div>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}
