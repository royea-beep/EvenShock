# Monitoring alert channels — the real options

When you decide to wire automated alerts on top of `owner_money_digest`,
this is the shortlist. The digest exists on demand today (`npm run
monitor:digest -- --alert` exits 1 on any red condition and emits a
one-line summary on STDERR — that's the plumbing every option below
just wraps).

The honest constraint: no always-on infrastructure, no paid ops tools,
must reach a phone within a minute of the red condition firing.

## Options

| Option | Reaches you as | Cost / mo | Cost / setup | Reliability | Latency | Effort to wire |
|---|---|---|---|---|---|---|
| **Discord webhook** | Push via Discord app on phone | $0 | Discord account + a channel + a webhook URL | Very high — Discord's own uptime | seconds | 10 min |
| **ntfy.sh push** | Push via ntfy app on phone | $0 | Install ntfy iOS/Android app | High — open source, ntfy.sh public server (or self-host) | seconds | 5 min |
| **Slack webhook** | Push via Slack app | $0 | Slack workspace + channel + webhook | Very high | seconds | 10 min |
| **Free-tier email (Postmark / SendGrid)** | Email | $0 up to a small monthly cap | Signup, API key | High delivery, but email is not push | minutes (depends on your mail client's fetch) | 15 min |
| **Pushover** | Push via Pushover app | $0 (one-time $5) | $5 one-time per platform + install | Very high — purpose-built for exactly this | seconds | 10 min |
| **Twilio SMS** | Text message | ~$0.008/message, and a monthly # rental (~$1) | Account + phone # | Very high — SMS is universal | seconds | 15 min |
| **PagerDuty free tier** | Push + escalation + SMS | $0 up to 5 users, some limits | Signup + integration | Very high, purpose-built | seconds | 20 min |

## Recommendation

**Discord webhook** if you already have Discord installed. Zero cost, zero
new app, instant push, and the webhook URL is a single string you can
add to `.env.local` and forget. The failure mode is "Discord is down for
everyone" which is rare enough to be irrelevant to a solo operator.

**ntfy.sh** if you don't already use Discord. Even lighter — one URL,
one app install, no accounts. The failure mode is the same but the
provider is smaller; you can self-host for genuine independence.

**Not recommended for launch**: SMS (Twilio) or Pushover — the marginal
per-message cost is trivial but the setup is heavier and you don't need
the SMS backbone for a system that fails rarely.

## How the wiring would work

Every option below is a variant of the same shape: cron calls the
digest with `--alert`, and pipes stderr to the notifier when exit 1.

### GitHub Actions cron + Discord webhook

`.github/workflows/monitor.yml` (not yet created):

```yaml
name: monitor
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: run digest
        env:
          VITE_SUPABASE_URL:         ${{ secrets.SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY:    ${{ secrets.SUPABASE_ANON_KEY }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: |
          if ! npm run --silent monitor:digest -- --alert 2>alert.txt; then
            summary=$(cat alert.txt | tail -1)
            curl -sSf -H 'Content-Type: application/json' \
              -d "{\"content\": \"🚨 EvenShock: $summary\"}" \
              "${{ secrets.DISCORD_WEBHOOK_URL }}"
          fi
```

Cost: $0. Interval: 15 min (GitHub cron's minimum reliable interval;
5 min is possible but often delayed). Total cost per year: 4 × 24 × 365
= ~35,000 runs, well within the free-tier 2,000-min/mo Actions budget
because each run is < 30 seconds.

### Same shape for ntfy.sh

Swap the curl for:
```bash
curl -sSf -d "🚨 EvenShock: $summary" ntfy.sh/evenshock-alerts-$RANDOM_TOPIC
```
Any topic name is a "channel"; subscribe from the phone app.

## Wiring — what actually shipped

**Telegram**, superseding the Discord recommendation above for one decisive
reason: it is where the owner actually lives day-to-day, and an alert
channel nobody checks is worth zero. The comparison table stands for anyone
choosing differently.

`.github/workflows/monitor.yml` runs the digest every 15 minutes. The alert
logic is unchanged — only RED conditions fire — and on RED the digest
pushes the one-line summary to a Telegram chat via the Bot API
(`https://api.telegram.org/bot<token>/sendMessage`). Delivery is
best-effort: if Telegram is down or the secrets are unset, the run still
exits 1 and the summary is still on stderr in the Actions log.

### One-time Telegram setup

1. **Create the bot.** Open <https://t.me/BotFather>, send `/newbot`,
   give it a display name and a username ending in `bot`. BotFather
   replies with the **token** (`123456789:AAF...`). That token is the
   secret — treat it like a password.
2. **Open a chat with your new bot** (BotFather's reply links it) and
   send it any message, e.g. `hi`. Bots cannot message you first; this
   one message is what authorizes it to push to you.
3. **Get your chat_id.** Visit
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and
   read `result[0].message.chat.id` from the JSON — a number like
   `123456789`. (If `result` is empty, send the bot another message and
   reload.)
4. **Add the repo secrets** at
   <https://github.com/royea-beep/EvenShock/settings/secrets/actions>:
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, alongside the existing
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
   `MONITOR_WEBHOOK_URL` is no longer read and can be deleted.
5. **Verify delivery independently of the monitor** (so a quiet monitor
   proves "no alerts", not "broken plumbing"):

   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/sendMessage" \
     -H 'Content-Type: application/json' \
     -d '{"chat_id": <YOUR_CHAT_ID>, "text": "EvenShock alert plumbing test"}'
   ```

   The message should appear in Telegram within a second, and the JSON
   response should say `"ok":true`.
6. **Then verify the workflow end-to-end**: `Actions → monitor → Run
   workflow` should exit 0 today (no red conditions) and post nothing.
   To see a real alert fire, deliberately trip one red condition and
   re-run — the run fails and the Telegram message arrives.
