# Contributor guide

Use Node.js 24 LTS and npm. Clone this repository, run `npm ci`, then `npm run check` and `npm run format:check`.

## App boundaries

Each app lives under `apps/<name>/`. It owns provider commands, webhook behaviour and presentation. Shared code under `src/` owns Buzz transport, storage, accounts and service lifecycle. Follow the interfaces in `src/core/types.ts` and the [architecture](architecture.md).

Include setup instructions, required provider permissions, command examples, representative messages and tests that exercise real behaviour and failures. Use neutral fixtures. A new app must not require a contributor's account, filesystem or infrastructure.

Use signed Buzz authors for authority and the linked person's provider account for their actions. Persist and reconcile uncertain writes. Test retries, permission failures, duplicate events and restarts. Never silently widen permissions to make an action work.

## Review and releases

Use a focused branch and Conventional Commits. Explain the final behaviour and validation in the pull request. Substantial changes to existing behaviour need a proposal issue first; fixes and new apps can arrive directly as pull requests.

CI runs on GitHub-hosted runners. Never add a public repository to a private or self-hosted runner pool. Release tags must match `package.json`; release automation publishes the archive, checksums and container image. Apps and the service version together.

Repository maintainers review shared interfaces and publish releases. App maintainers review their provider behaviour and respond to relevant issues. Discussions are not required: use Issues and pull requests.

## npm publishing

The first publication requires a maintainer's npm account. Build and inspect `npm pack --dry-run`, then publish the release candidate with `npm publish --access public --tag next`. Subsequent releases use the `Publish npm` workflow and npm trusted publishing.

In npm's package settings, configure GitHub owner `aicayzer`, repository `buzz-apps`, workflow filename `npm-publish.yml` and environment `npm`. Allow direct `npm publish` for this workflow. Configure the matching GitHub environment, then run the workflow against an existing release tag. No npm token is stored in GitHub. The workflow publishes release candidates to `next` and stable releases to `latest`.

These settings follow [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/), checked September 2026. OIDC needs npm 11.5.1 or newer; Node.js 24 supplies a compatible npm version.
