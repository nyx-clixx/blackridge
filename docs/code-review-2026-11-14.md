# Code review — November 14, 2026

Reviewed the HTTP authentication/authorization and policy routes, bot dispatch and protection lifecycle, moderation/reporting, appeals, verification, recovery and backup storage, logging, analytics, Custom Bot lifecycle, Stripe billing/storage, and dashboard save/render paths. Changes were limited to reproduced defects.

## Verified fixes

- Discord log delivery now forwards file attachments. Cards with attachments are delivered separately so same-named files from different cards cannot collide or be merged away.
- Mounted Discord event handlers now catch both synchronous exceptions and rejected asynchronous handlers. Diagnostics exclude the error message to avoid exposing tokens or user content. Existing server ownership filtering remains in place.
- HTTP 429 errors now return their actionable message, including manual backup cooldown instructions, instead of a generic failure. Exercised with the actual middleware in an isolated HTTP harness.

- Empty bot-token configuration now produces a disconnected status response instead of HTTP 500. Public endpoint behavior is exercised against a real child server with no Discord credentials.

## Checks

- 52 committed automated regression and integration tests pass, including the new attachment and handler-failure tests.
- JavaScript syntax checks pass for all 34 source/test files present at the initial scan; the added test file is also executed by the suite.
- npm security advisory bulk lookup returned no advisories for the 84 installed package names discovered through the dependency graph. This is a point-in-time check, not a guarantee that dependencies contain no vulnerabilities.
- Git whitespace checks pass. There is no configured lint or build script; the application runs JavaScript directly.

## Remaining limits

No live charge, subscription cancellation, ban, role mutation, or real user report was generated during this review. Discord and Stripe behavior was tested with fixtures; real account configuration and API permissions still matter. This is a code review and regression pass, not an independent penetration test or proof of exhaustive correctness. Larger rewrites and speculative behavior changes were deliberately excluded.
