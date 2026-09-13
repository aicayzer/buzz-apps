# Service design

Buzz Apps is one Node.js process per installation, with SQLite-backed state and a separate Buzz identity and provider credentials for each enabled app. The first app is GitHub. No AI model, Buzz CLI, n8n or personal agent configuration is required at runtime.

## Boundaries

- `apps/github/` owns GitHub commands, subscription filters, notifications, previews and reminders.
- `src/buzz/` owns signed Buzz events, relay authentication, reconnects, private channels and delivery recovery.
- `src/core/` owns external configuration, encrypted accounts, durable storage and private browser forms.
- `src/service.ts` composes enabled apps, HTTP endpoints and background work.
- `src/cli/` owns setup, npm installation lifecycle and native background services.

Apps are compiled modules with explicit interfaces. Adding an app means adding reviewed code and tests to this repository. There is no downloaded-code marketplace or automatic activation. Shared setup enables no apps; each enable operation supplies that app's identity and credentials.

## Identity and permissions

A deployment registers its own GitHub App and installs it on selected repositories. Installation tokens serve background integration work. Actions use the connected person's GitHub user token. A signed Buzz author identifies the person; profile names and textual mentions do not establish identity.

Account linking starts with an expiring private link, a browser-bound OAuth state and GitHub authorisation. Access and refresh tokens are encrypted in SQLite with an external encryption key. Buzz private messages are relay-protected private channels, not end-to-end encrypted messages. They carry links, never raw credentials.

A channel owner or administrator with GitHub repository access can subscribe a channel. This is sufficient authorisation to share private repository notifications with its members; the service does not check every recipient's GitHub access. Private previews are limited to subscribed repositories or a private reply. Writes always retain the person's GitHub permissions.

## Delivery and recovery

Webhooks are verified against the raw-body HMAC, persisted before acknowledgement and deduplicated by GitHub delivery ID. Related notification state is stored per channel and GitHub object. Work is serialised by the process, and a filesystem lock prevents two processes opening the same service data directory.

Outgoing Buzz events are signed and stored before submission. Retries preserve their event ID; logical deduplication keys cover crashes between sending and recording an app's progress. Incoming events are signature-checked, remembered and recovered after reconnect. The first start ignores historical commands.

GitHub writes have an action journal. An uncertain non-idempotent result must be checked in GitHub before another attempt. The service must never convert an ambiguous timeout into a duplicate issue or comment. An expired undelivered Buzz event remains a visible failure rather than being silently resigned.

Updates are explicit. The CLI manages the existing npm installation and backs up matching executable, configuration and database state for recovery. Restoring only an older executable against a newer database is not a supported rollback.

## Operating surface

The public HTTPS endpoint receives GitHub webhooks, app registration callbacks and account-linking forms. Native operation binds loopback by default; the operator supplies HTTPS routing. Docker runs the same process with persistent configuration and data volumes. Health responses contain aggregate readiness only. Logs omit tokens, webhook payloads and private message content.

Protocol compatibility was checked against Buzz upstream on 13 September 2026. Use the tests and release notes to assess later upstream changes; the repository does not bundle or modify Buzz.
