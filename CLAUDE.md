# Buzz Apps

Public, portable TypeScript apps for Buzz. Read README.md and docs/architecture.md.

- Keep personal paths, deployment domains, identities, credentials and vault references outside this repository.
- Buzz source and protocol documentation are authoritative for integration behaviour.
- Each app owns its commands and provider behaviour; shared transport, storage and service lifecycle belong in src/.
- Persist signed outgoing events before delivery. Never turn an uncertain write into a new write without reconciliation.
- Use the linked person's GitHub authority for actions. Installation credentials are for background integration work.
- Run npm run check and npm run format:check before publishing changes. Test observable failure and permission boundaries.
- Public CI uses GitHub-hosted runners only. Use Conventional Commits. Do not commit runtime data or secrets.
