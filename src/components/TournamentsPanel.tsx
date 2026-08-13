import { motion } from 'framer-motion';
import { copy } from '../constants/copy';
import {
  groupByRound,
  isBye,
  nextPlayableSlot,
  roundLabel,
  type BracketSlot,
  type TournamentMoney,
  type TournamentSummary,
} from '../data/tournaments';
import type { TournamentsState } from '../hooks/useTournaments';

/**
 * Tournaments: lobby, entry confirmation, bracket, payout.
 *
 * THE DISCLOSURE RULE, inherited from the stake-table screens and not weakened
 * here: the cost is on screen BEFORE the commitment, never after it. The lobby
 * card carries the entry fee and the pool; pressing Enter opens a confirm step
 * that states them again with the player count, because a fee glanced at in a
 * list is not a fee agreed to. Nothing is charged until the second press.
 *
 * AND THE HONEST-ENDING RULE: the payout panel shows the arithmetic, not just
 * the arrival — `pool − house 0 = paid out`, then what this player put in and
 * took out. Saying "house 0" out loud on a screen that never had a rake looks
 * redundant until you remember the same player has read the friend-match copy,
 * where the cut is real. Silence there would read as a cut they were not told
 * about.
 *
 * WHAT THIS COMPONENT DOES NOT DO: play. Pressing "Play your match" opens the
 * bracket slot's mp table and hands its invite code to the friend-match flow,
 * which owns every screen from there. A tournament match is an ordinary table;
 * building a second board here is how the two would drift apart.
 */
interface TournamentsPanelProps {
  tournaments: TournamentsState;
  /** Enters the mp table for a slot. Given the invite code, the parent starts
   *  the friend-match flow and closes this panel. */
  onPlay: (inviteCode: string) => void;
}

export function TournamentsPanel({ tournaments: t, onPlay }: TournamentsPanelProps) {
  if (t.phase.kind === 'closed') return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-40 overflow-y-auto bg-[rgba(10,10,14,0.9)] p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={copy.tournaments.title}
    >
      <motion.div
        initial={{ y: 12 }}
        animate={{ y: 0 }}
        className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 bg-elevated p-4 text-ink sm:min-h-0 sm:gap-6 sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="display-type text-xl font-extrabold sm:text-2xl">
            {t.phase.kind === 'bracket' && t.money ? t.money.name : copy.tournaments.title}
          </h2>
          <button
            type="button"
            onClick={t.phase.kind === 'bracket' ? t.backToList : t.close}
            className="text-xs text-muted underline decoration-dotted hover:text-ink"
          >
            {copy.tournaments.close}
          </button>
        </div>

        {t.error && (
          <p role="alert" className="rounded-sm bg-page px-3 py-2 text-xs text-muted">
            {copy.tournaments.blocked[t.error] ?? t.error}
          </p>
        )}

        {t.phase.kind === 'list' && <Lobby t={t} />}
        {t.phase.kind === 'confirm' && <Confirm t={t} tournament={t.phase.tournament} />}
        {t.phase.kind === 'bracket' && <Bracket t={t} onPlay={onPlay} />}

        <p className="text-[11px] leading-snug text-muted">{copy.stakes.noCashValue}</p>
      </motion.div>
    </motion.div>
  );
}

// ------------------------------------------------------------------- lobby

function Lobby({ t }: { t: TournamentsState }) {
  if (!t.listLoaded) {
    return <p className="py-6 text-center text-sm text-muted">{copy.leaderboard.loading}</p>;
  }
  if (t.tournaments.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">{copy.tournaments.empty}</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {t.tournaments.map((row) => (
        <li key={row.id} className="rounded-sm bg-page p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="font-semibold">{row.name}</span>
            <span className="text-xs text-muted">
              {copy.tournaments.entrants(row.entrants, row.maxPlayers)}
            </span>
          </div>

          {/* The two numbers that decide whether to press anything, on the
              card itself rather than one tap away. */}
          <p className="mt-1 text-xs text-muted">
            {row.entryFee > 0 ? copy.tournaments.entryFee(row.entryFee) : copy.tournaments.entryFree}
            {' · '}
            {copy.tournaments.pool(row.prizePool)}
          </p>

          <div className="mt-2 flex items-center gap-3">
            {row.youEntered || row.status === 'running' ? (
              <button
                type="button"
                onClick={() => t.view(row.id)}
                className="rounded-sm bg-elevated px-3 py-1.5 text-xs font-semibold hover:opacity-90"
              >
                {copy.tournaments.bracketTitle}
              </button>
            ) : row.joinBlock ? (
              // The reason, not a dead grey button. A disabled control with no
              // explanation is indistinguishable from a broken one.
              <span className="text-xs text-muted">{copy.tournaments.blocked[row.joinBlock]}</span>
            ) : (
              <button
                type="button"
                onClick={() => t.askJoin(row)}
                className="rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent hover:opacity-90"
              >
                {copy.tournaments.joinConfirm(row.entryFee)}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ----------------------------------------------------------------- confirm

function Confirm({ t, tournament }: { t: TournamentsState; tournament: TournamentSummary }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-semibold">{copy.tournaments.joinTitle}</h3>
      <p className="text-sm text-muted">{tournament.name}</p>

      {/* Fee, pool and how full it is — restated here even though the card
          showed them, because a number seen in a list is not a number agreed
          to. Same discipline as the stake join notice. */}
      <p className="rounded-sm bg-page px-3 py-2 text-sm">
        {tournament.entryFee > 0
          ? copy.tournaments.joinNotice(
              tournament.entryFee,
              tournament.prizePool,
              tournament.entrants,
              tournament.maxPlayers,
            )
          : copy.tournaments.joinFreeNotice(tournament.entrants, tournament.maxPlayers)}
      </p>
      <p className="text-xs text-muted">{copy.tournaments.poolLine}</p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={t.confirmJoin}
          disabled={t.busy}
          className="rounded-sm bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-60"
        >
          {t.busy ? copy.tournaments.joining : copy.tournaments.joinConfirm(tournament.entryFee)}
        </button>
        <button
          type="button"
          onClick={t.cancelJoin}
          className="rounded-sm bg-page px-4 py-2 text-sm font-semibold"
        >
          {copy.tournaments.joinCancel}
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- bracket

function Bracket({ t, onPlay }: { t: TournamentsState; onPlay: (code: string) => void }) {
  const rounds = groupByRound(t.slots);
  const total = rounds.length;
  const playable = nextPlayableSlot(t.slots);
  const finished = t.money?.status === 'complete';

  return (
    <div className="flex flex-col gap-4">
      {t.money && <MoneyHeader money={t.money} />}

      {finished && t.money ? (
        <Payout money={t.money} />
      ) : playable ? (
        <div className="flex flex-col gap-2 rounded-sm bg-page p-3">
          <p className="text-sm">{copy.tournaments.yourMatchReady}</p>
          <button
            type="button"
            disabled={t.busy}
            onClick={() => {
              void t.playSlot(playable.roundNo, playable.slot).then((code) => {
                if (code) onPlay(code);
              });
            }}
            className="self-start rounded-sm bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-60"
          >
            {t.busy ? copy.tournaments.opening : copy.tournaments.playNow}
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted">{copy.tournaments.waitingOnOthers}</p>
      )}

      {rounds.map(({ roundNo, slots }) => (
        <section key={roundNo} className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-muted">{roundLabel(roundNo, total)}</h3>
          {slots.map((s) => (
            <SlotRow key={`${s.roundNo}-${s.slot}`} slot={s} />
          ))}
        </section>
      ))}
    </div>
  );
}

function MoneyHeader({ money }: { money: TournamentMoney }) {
  return (
    <div className="rounded-sm bg-page px-3 py-2 text-xs text-muted">
      {money.entryFee > 0 ? copy.tournaments.entryFee(money.entryFee) : copy.tournaments.entryFree}
      {' · '}
      {copy.tournaments.pool(money.pool)}
    </div>
  );
}

function SlotRow({ slot }: { slot: BracketSlot }) {
  const bye = isBye(slot);
  return (
    <div className="flex items-center justify-between gap-3 rounded-sm bg-page px-3 py-2 text-sm">
      <span className="flex min-w-0 flex-col gap-0.5">
        <Side name={slot.a.name} seed={slot.a.seed} won={slot.winner != null && slot.winner === slot.a.id} />
        {/* A bye is not a match anybody played, so the empty side says so
            rather than rendering a blank opponent who appears to have lost. */}
        {bye && slot.b.id == null && slot.a.id != null ? (
          <span className="text-xs text-muted">{copy.tournaments.bye}</span>
        ) : (
          <Side name={slot.b.name} seed={slot.b.seed} won={slot.winner != null && slot.winner === slot.b.id} />
        )}
      </span>
      <span className="shrink-0 text-xs text-muted">
        {slot.status === 'complete'
          ? copy.tournaments.won
          : bye
            ? copy.tournaments.bye
            : copy.tournaments.waiting}
      </span>
    </div>
  );
}

function Side({ name, seed, won }: { name: string | null; seed: number | null; won: boolean }) {
  if (!name) return <span className="text-xs text-muted">{copy.tournaments.tbd}</span>;
  return (
    <span className={won ? 'font-semibold' : undefined}>
      {seed != null && <span className="mr-1.5 text-xs text-muted">{copy.tournaments.seed(seed)}</span>}
      {name}
    </span>
  );
}

// ------------------------------------------------------------------ payout

function Payout({ money }: { money: TournamentMoney }) {
  const you = money.you;
  const champion = money.podium.find((p) => p.position === 1);

  return (
    <div className="flex flex-col gap-2 rounded-sm bg-page p-3">
      <h3 className="font-semibold">{copy.tournaments.resultTitle}</h3>
      {champion && <p className="text-sm">{copy.tournaments.champion(champion.name)}</p>}

      {you && (
        <>
          <p className="text-sm font-semibold">
            {you.position === 1
              ? copy.tournaments.wonTitle(you.prize)
              : you.position === 2
                ? copy.tournaments.runnerUpTitle(you.prize)
                : copy.tournaments.placedTitle(you.position ?? 0)}
          </p>
          {/* The arithmetic, in full. `house 0` is stated rather than implied
              by the pool matching the payout. */}
          <p className="text-xs text-muted">
            {you.prize > 0
              ? copy.tournaments.breakdown(money.pool, you.paid, you.prize, you.net)
              : copy.tournaments.noPrize(you.paid)}
          </p>
        </>
      )}

      <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted">
        {money.podium.map((p) => (
          <li key={`${p.position}-${p.name}`}>
            {p.position}. {p.name} — {p.prize} chips
          </li>
        ))}
      </ul>
    </div>
  );
}
