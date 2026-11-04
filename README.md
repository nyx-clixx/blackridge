# Blackridge

Blackridge combines a Discord security bot, public landing page, and OAuth2 management dashboard. It runs as one Node.js service with SQLite for per-server policies and 30 days of security events.

## Run locally

1. Install Node.js 24 and pnpm 11.25.0.
2. Run `pnpm install --frozen-lockfile`, then copy `.env.example` to `.env`.
3. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Add `http://localhost:3000/auth/callback` as an OAuth2 redirect URI. Enable the **Server Members Intent** on the Bot tab.
4. Set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_BOT_TOKEN` in `.env`. Run `pnpm start` and visit [Blackridge locally](http://localhost:3000).
5. Use **Add to Discord**, then place the bot role above the roles it should be able to moderate. Sign in and select the server. Owners edit policies. Managers can view policies and incident history.

The landing page and dashboard sign-in screen can be previewed before supplying Discord credentials. Run the automated checks with `pnpm test`.

## Protection behavior

- **Anti-Nuke** counts relevant audit events per executor within a sliding window. It tracks channel and role deletions, dangerous role permission additions or assignments, bot additions, kicks, and bans. The server owner, Blackridge, and configured trusted accounts are exempt. The response can log, kick, or remove editable roles that confer dangerous permissions.
- **Anti-Raid** counts joins across the server. At the threshold it starts a protection window and applies the chosen response to qualifying arrivals from that point forward. The account age filter applies to the response. A zero-day filter includes all account ages. Timeouts last ten minutes.
- Both policies begin in log-only mode. Enforcement depends on the bot’s permissions and role hierarchy. Anti-Nuke responds after Discord records a change, so deleted channels and roles are not restored. Detection windows and sessions reset on process restart.

## Deploy to Railway

Create a private GitHub repository from this directory and connect it as the source of a Railway service. Railway uses the included Dockerfile and checks `/healthz`. Attach a persistent volume at `/data` and set `DB_PATH=/data/blackridge.sqlite`. Use a single replica.

Generate a public Railway domain, set `PUBLIC_URL` to that HTTPS origin, then register `<PUBLIC_URL>/auth/callback` in the Discord application. Add the three Discord environment variables in the Railway service settings and deploy. Store secrets in Railway variables. For verification, check that `/healthz` reports `botConnected: true` and `oauthConfigured: true`, then test both modules in a controlled Discord server with log-only policies.

## API references

- [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)
- [Discord audit logs](https://docs.discord.com/developers/resources/audit-log)


## Stripe Billing

Use the variables listed in `.env.example` to configure billing. Store the restricted Stripe API key and webhook signing secret in Railway Variables. Use a separate Stripe sandbox and database for testing. Set `STRIPE_LIVEMODE=true` only in production.

Create separate monthly prices for Blackridge Premium and Blackridge Custom Bot. Configure a Stripe customer portal with payment method updates, invoice history, end-of-period cancellation, and price changes between both plans. Set upgrades to invoice prorations immediately and schedule downgrades for the end of the billing period.

Point the Stripe webhook to `/webhooks/stripe` and subscribe to Checkout completed, expired, asynchronous payment succeeded and failed, subscription created, updated and deleted, invoice paid and payment failed, charge refunded, charge dispute created, and Radar early fraud warning created events. The restricted key needs Checkout Sessions and Customer Portal Sessions write access, and Subscriptions, Invoices, and Invoice Payments read access.

Full refunds, disputes, and early fraud warnings place paid access on hold. Review those payments in Stripe before clearing the corresponding row in `billing_risk` through authorized database maintenance.
