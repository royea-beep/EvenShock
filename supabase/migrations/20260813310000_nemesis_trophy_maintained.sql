-- NEMESIS, part 5: the trophy, actually maintained.
--
-- `nemesis_touch_best` was written in part 4 and never called by anything. A
-- personal best that no code path updates is not a trophy, it is a column that
-- is permanently null — and it would have shipped looking like a feature. So
-- it is replaced here by a trigger, and dropped.
--
-- WHY A TRIGGER RATHER THAN A CALL AT THE END OF refresh_player_skill_metrics.
-- The metrics row is written from more than one place — solo finalization,
-- mp_settle, and the backfill entry point — and every one of them is a place
-- somebody could add a fourth and forget. A BEFORE trigger on the row itself
-- cannot be forgotten: the best is maintained by the act of writing the score,
-- not by remembering to ask.
--
-- WHY IT IS GATED ON CONFIDENCE. Below the confidence floor a low
-- predictability score is small-sample noise, not a performance. Enshrining
-- noise as a personal best would make the trophy unbeatable by actually
-- improving, which is the exact opposite of what it is for.

create or replace function public.nemesis_keep_best()
returns trigger
language plpgsql
set search_path to '' as $$
begin
  -- Nothing worth recording yet: carry whatever was already there. On UPDATE
  -- that means the caller cannot clear the best by writing a calibrating row,
  -- which matters because the metrics are recomputed from scratch each time.
  if new.predictability_score is null or new.confidence = 'calibrating' then
    if tg_op = 'UPDATE' then
      new.lowest_predictability    := old.lowest_predictability;
      new.lowest_predictability_at := old.lowest_predictability_at;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.lowest_predictability is not null then
    if new.predictability_score < old.lowest_predictability then
      new.lowest_predictability    := new.predictability_score;
      new.lowest_predictability_at := now();
    else
      new.lowest_predictability    := old.lowest_predictability;
      new.lowest_predictability_at := old.lowest_predictability_at;
    end if;
    return new;
  end if;

  new.lowest_predictability    := new.predictability_score;
  new.lowest_predictability_at := now();
  return new;
end $$;

drop trigger if exists nemesis_best_maintained on public.player_skill_metrics;
create trigger nemesis_best_maintained
  before insert or update on public.player_skill_metrics
  for each row execute function public.nemesis_keep_best();

comment on column public.player_skill_metrics.lowest_predictability is
  'Lowest predictability score this player has reached at or above the '
  'confidence floor. Maintained by the nemesis_best_maintained trigger, and '
  'readable by the player through the table''s own-row policy — the trophy '
  'needs no privileged route because it is a fact about the reader.';

-- Superseded. Dropped rather than left in place: an uncalled function with a
-- verb for a name is an invitation to call it, and calling it now would be a
-- second, redundant write of something the trigger already guarantees.
drop function if exists public.nemesis_touch_best(uuid);

-- Backfill the players who already have a scored metrics row. A no-op UPDATE
-- fires the BEFORE trigger, which is exactly the point: the maintenance rule
-- is applied to history by the same code that will apply it going forward.
update public.player_skill_metrics set predictability_score = predictability_score
 where predictability_score is not null and confidence <> 'calibrating';
