# Security

Report suspected vulnerabilities privately through [GitHub security advisories](https://github.com/aicayzer/buzz-apps/security/advisories/new). Include the affected release, reproduction steps and impact. Do not publish secrets or private repository content in issues.

Security fixes target the latest release. Release candidates are intended for evaluation; check release notes before upgrading.

Run each installation with its own GitHub App and Buzz identity. Keep external configuration and encryption keys readable only by the service account. Back up the configuration together with its database: losing the encryption key makes linked account tokens unrecoverable.

Subscribing a private repository authorises notifications in that Buzz channel. Every channel member may see those messages regardless of their GitHub access. Buzz DMs provide relay-enforced privacy, not end-to-end encryption. Do not send credentials through channel messages or DMs.
