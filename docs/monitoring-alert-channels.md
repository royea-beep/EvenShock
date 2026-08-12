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

## The decision that isn't in this doc

Which channel matches your inbox habits. That's the whole question, and
the reason this decision is not mine to make. When you say "wire the
digest to X", I do the 15 minutes of plumbing.
