-- Harness accounts are BORN flagged, not tagged afterwards.
--
-- WHAT WENT WRONG, because the fix only makes sense against it. is_harness was
-- added as a marker somebody applies. Thirteen harness-created accounts reached
-- production without it, and two of those became the first and only rows on the
-- ladder — a ranking whose entire top was synthetic. Every exclusion built on
-- is_harness was correct and excluded nobody, because the accounts that needed
-- excluding were not flagged.
--
-- Tagging those thirteen fixes thirteen accounts. It does not fix the fourteenth,
-- which is why this migration is about WHEN the flag is set rather than about
-- who currently has it.
--
-- HOW IT WORKS NOW. Every seed a harness can sign with is derived in exactly one
-- module, scripts/harness/wallets.mjs. Its addresses are registered here, and
-- handle_new_web3_identity — the trigger that provisions a profile the first
-- time a wallet signs in — stamps is_harness = true when the address is in the
-- registry. The flag is therefore set BEFORE the account can play a round,
-- enter a tournament, or be rated. There is no window in which a harness
-- account is an ordinary player.
--
-- THIS FILE IS GENERATED from that module. wallets.sync.test.ts fails the build
-- if they disagree, so the registry cannot drift from the seeds it describes —
-- the same discipline as rules.sync.test.ts.
--
-- AND THE BACKSTOP THAT ACTUALLY HOLDS: signInWithKeypair refuses to return a
-- session whose profile is not flagged. A seed added to the module but never
-- migrated dies on its first run with an explanation, rather than silently
-- creating a player. Generated files and drift tests can be skipped by someone
-- in a hurry; a harness that will not start cannot be.

create table if not exists public.harness_wallets (
  wallet_address text primary key,
  label          text not null,
  added_at       timestamptz not null default now()
);
comment on table public.harness_wallets is
  'Wallets belonging to test harnesses. Generated from scripts/harness/wallets.mjs; profiles created for these addresses are born is_harness = true.';

alter table public.harness_wallets enable row level security;
revoke all on public.harness_wallets from anon, authenticated;

insert into public.harness_wallets (wallet_address, label) values
  ('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', 'rounds.live.test — the solo round-trip player'),
  ('J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf', 'browser harness (RETIRED seed, account still live)'),
  ('7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9', 'stake-match + tournament, seat A'),
  ('mBKqcnGotbsSb5vNrdyhzZ5EhqZdids9QYiTRckvi7v', 'stake-match + tournament, seat B'),
  ('8tizr7gdCYjfrrJwSRREwp9ogo1oGz7ieK2c58Ku7fv1', 'browser harness (current)'),
  ('AQQsM5fCd1kXHJZYpckbzhNJPiFibH7GbMJphT6QNKpU', 'load-abuse user #0'),
  ('EEJQ4CbyfaWFanrim5gyTeDbQ9nUrLL9PN7sVaAJn4h9', 'load-abuse user #1'),
  ('2wapTMkvGvXTqcGRxZpNdfUBHhsDpSRsMhvJdW9jN238', 'load-abuse user #2'),
  ('DqqkfiARZwqtttMn87fi6BbL8WhUAqV3iEgVgZeMFtoP', 'load-abuse user #3'),
  ('Hbzp12kPgnAdZXj33TrUSYq9kKSxyR1sLYHe1KqWNrnM', 'load-abuse user #4'),
  ('CD9tvmEA6siPrUbbRTmzH5BcrBJFyvozZPY6XD9jbtCL', 'load-abuse user #5'),
  ('3395kFDoQwGSchXFc6jDPJg1BDUgwrj1g3SVGW2cnxtC', 'load-abuse user #6'),
  ('EcjWhu68CAU8F84unZ5yNF3Vjy8uuxxRvNFvZvrB63qh', 'load-abuse user #7'),
  ('7gya9xShRXqm5D12EcYBBXavhDv8e6GKywDfwfrM2A7X', 'load-abuse user #8'),
  ('QWCS31VgJivmaM4Tr7VM5R1u4QJ8JFCZ6PXUcZKBc1R', 'load-abuse user #9'),
  ('FeX2vvnfd6KhdmtyomVjXKTN9dNPR4SpBnnyk1KGaVKd', 'load-abuse user #10'),
  ('Bs7rNVDTz6Xy4Vi5iDwH15A4hhVAup4Sk44Y6LFZpZAJ', 'load-abuse user #11'),
  ('7cDNsHX6tYspx2hf1b7EJH5pEKEN6kDdSGeH142e3Cpn', 'load-abuse user #12'),
  ('CmEA8iv3dKXHVoDVBrrmun6Wwk17qDFycjD5arMb5rMK', 'load-abuse user #13'),
  ('5Zgz94DzMHLX28wXCN5zvHaLnVH3VMkyJLiwDGsqWwH5', 'load-abuse user #14'),
  ('E8gmbaKesmmXXUcQiBLmTfDCGyT3efcjNE34XXXnc8Db', 'load-abuse user #15'),
  ('AHuEYL6qvd2NJY3PLdzG3yjX1rc8jrj1A195pRWGoJUj', 'load-abuse user #16'),
  ('5koWLMAJJW1wsq2ngAQag7t6paWD7nP6cpNZUBVigUkC', 'load-abuse user #17'),
  ('Atugm9nEDgN1ZGV8nq5W4eec8uFsYz5W1tYwZ2PJi5hX', 'load-abuse user #18'),
  ('3SVD727DAtjLMkbH8U3rKngEEq5sQQEeAxT7LgRKGFHJ', 'load-abuse user #19'),
  ('DLcWSavci9kG9sGxByhxP7zbTSCtjC7hSaXZLzjnufdN', 'load-abuse user #20'),
  ('2doQnkjrwACiKxME6PqjJhC7a2esL1C2jKhnoySuH6EU', 'load-abuse user #21'),
  ('7JdFD8DBad9ScZyrNcwKHZ6LRZzhBVuAwnuB8UbgbJ3c', 'load-abuse user #22'),
  ('GhXBa9FJ8VMiDCQT43v5GrvV62SpqmHZxnGg4Gg85Rm9', 'load-abuse user #23'),
  ('F32XMcRghFibwv3ahZxu4uWFanVXoj3KDfoYpL2CutTb', 'load-abuse user #24'),
  ('4gGH756mGvo3NHASb6E6SFxxkdJNx3CmmG5mUTrZTh6s', 'load-abuse user #25'),
  ('54TRcuorV6axT5NGtHBHM2XioAECjUwvgrWVAvUYXAYS', 'load-abuse user #26'),
  ('zQqpULtY9kwbPQBKPpAgGV7bsx8CBQxCuE2eS4M2nbq', 'load-abuse user #27'),
  ('Ec9qMymp3zsLtkvpCArUzb3Um8soNNz6We1HWX6pU19X', 'load-abuse user #28'),
  ('Fy11ciyKkrNfLYP2zSnJMdHsLpagC4AFgn6atEpUHxDs', 'load-abuse user #29'),
  ('JE4TrcZHqDCRb5eucdxa9cLkG9f2LnJnKwtbJkJHJHA7', 'load-abuse user #30'),
  ('AqZfZJbFWn3MwqoS7w6hn7vSEFUTwfSNnpoHAk9hPhAG', 'load-abuse user #31'),
  ('GhU8xsZ65t96w1aBkC4Y8nb1BH6j29F2bzw7pwCKMVP2', 'load-abuse user #32'),
  ('4Lu588KEcg2Q1eWntcujyZv5PNSD3rYSBN1bGHAyZP3r', 'load-abuse user #33'),
  ('GSmqz4fX2qBhQvndfuEjSxcPiyfcNjHbNrb9yFZryz1d', 'load-abuse user #34'),
  ('CNRKp7AeLpKqfJRg6CkZcZbGENCZUZ86UHM6MUhhaqcf', 'load-abuse user #35'),
  ('DYTgDjJqF9mMjnn8V7Vxb2FqqYQwtfkua9bssTQAMygU', 'load-abuse user #36'),
  ('5ipHW8A7UQJuUjufE4bydmswYu4i4unDYwYF8utNvzLg', 'load-abuse user #37'),
  ('GNt6CdidL6TN4ZfKbs9iPY766vVmyxreU1CZnzfVVGcz', 'load-abuse user #38'),
  ('3baDGdBiM8NNi1bBtBXnBcnMzLavpdGJcq2FURPxFqME', 'load-abuse user #39'),
  ('4A9GyzqrE2SASmacsRAw8P41YAp6kEVuYWEDE4Y8zmvs', 'load-abuse user #40'),
  ('4QjpzQeqUy1ZazztfXaHXLWSZB2NMLKNdqp416oGCTRU', 'load-abuse user #41'),
  ('6cPao9Pu1yT7oGjjsyNSdB86ofF26bzQjB4hCYX12RWZ', 'load-abuse user #42'),
  ('AkPVChNFM8QVVpdPVPXDQDi1ZKSMYg9CiGJLtSxF41WU', 'load-abuse user #43'),
  ('DuB7u6MnKtQbebnUpBEjqBUCqn8rziGXHU4gc45ZZ3gg', 'load-abuse user #44'),
  ('7RiNB1CuhQee3tDcY4emCTCwMjKRN7raNmttC1N7ZS1x', 'load-abuse user #45'),
  ('FA2hUWQLr3y8uGBuPXqgbHpZSMDBqbP1xL9JzueB83Cy', 'load-abuse user #46'),
  ('NoUVmfdqWqP8DPUjRWfoov2m4Qsfgk2G2gyBx2JkTPm', 'load-abuse user #47'),
  ('9ywoEBQvj3p27qQR9fo75D6oSSRhUZJ9GTkvxyTN7s3V', 'load-abuse user #48'),
  ('GwRDQ4qhmyzU1gJAgXtpnc4V72qe3pnEccKgK2K8qcrx', 'load-abuse user #49'),
  ('Gb8dTw1wHaVupcD1tNABCGYbLnS4GZQ1mecZLtNJxRCM', 'load-abuse user #50'),
  ('MugSzUuAM3ZQVWuFxoDoiNyqHMxgUPkRmnV6iXjXMTk', 'load-abuse user #51'),
  ('8HUBbKPUpeLnPae8f4ircq6mMytABdzN14JR71LWkEaQ', 'load-abuse user #52'),
  ('ECyAtAEXuX7msvWNx26vwMLqKpsx8cAkohxfSuunsHAx', 'load-abuse user #53'),
  ('B1q344RZba6PjtK5o8gQTju26Gco1hhJbr1wPruuSEDf', 'load-abuse user #54'),
  ('3H9xnb9V3NNaKcmGfayQhgEDedKCdzCg7GJcAXMeB8MP', 'load-abuse user #55'),
  ('AcKskjKSi4bT8yesUQD5VUqCcz2d7hiZwgUWkgYamHnx', 'load-abuse user #56'),
  ('7pfsZ9N87TX1hq7fBsWHdvVAvZUU142dELc5S47QWvHF', 'load-abuse user #57'),
  ('2iQTM5YMEWPEqA9kfMduuCUKpoSsdsUZK7Vwe5ijnfFQ', 'load-abuse user #58'),
  ('NK9GwgDnd5QHKLMfahuVjDfmmzzPR6GPdbr7WXDGqTq', 'load-abuse user #59'),
  ('9TmVeQmkw7dpVsTMvJemnBcUvp9GCesderZLjfZ8Rzj8', 'load-abuse user #60'),
  ('Cf92ZQCySQXWkcxqcoT6YYeZT381HqnAQCviojQY9qXw', 'load-abuse user #61'),
  ('CSbpnvchzEbkB9jXeuYMTXiA8p7HCfMr5FcEW2fDBovV', 'load-abuse user #62'),
  ('J8xHNBpBCWVy7wsKoxTektqp2sZPH45DQkraPmJqDKPC', 'load-abuse user #63')
on conflict (wallet_address) do update set label = excluded.label;

-- The provisioning trigger, now stamping the flag at creation. Everything above
-- the is_harness line is unchanged.
create or replace function public.handle_new_web3_identity()
returns trigger
language plpgsql security definer set search_path to '' as $function$
declare
  address text;
  v_harness boolean;
begin
  address := coalesce(
    nullif(new.identity_data ->> 'address', ''),
    nullif(new.identity_data ->> 'wallet_address', ''),
    public.strip_wallet_namespace(nullif(new.provider_id, ''))
  );

  if address is null then
    return new;
  end if;

  if new.provider not in ('web3', 'solana', 'ethereum') then
    return new;
  end if;

  v_harness := exists (select 1 from public.harness_wallets hw
                        where hw.wallet_address = address);

  insert into public.profiles (id, wallet_address, is_harness)
  values (new.user_id, address, v_harness)
  on conflict (id) do update
    set wallet_address = excluded.wallet_address,
        -- Only ever raised here, never lowered: re-signing in must not clear a
        -- flag, and an account that was once a harness stays one.
        is_harness     = profiles.is_harness or excluded.is_harness,
        updated_at     = now();

  return new;
end;
$function$;

-- Backfill: every profile whose wallet is registered, flagged now. This is the
-- thirteen — including the retired fill(9) account with 378 rocks, and the two
-- that reached the ladder.
update public.profiles p
   set is_harness = true, updated_at = now()
  from public.harness_wallets hw
 where hw.wallet_address = p.wallet_address and not p.is_harness;

-- A harness account must hold no rating. player_ratings is a derived cache --
-- rebuildable from rating_history -- so clearing it costs nothing and leaves
-- the ladder honest. rating_history itself is NOT touched: it is append-only by
-- trigger, and those rows are a true record that the system rated a real
-- settled match between two accounts nobody had flagged yet. That record is the
-- only durable evidence of this bug, and deleting the evidence of a mistake is
-- how the mistake gets made twice.
delete from public.player_ratings pr
 where not public.is_rateable_player(pr.user_id);
