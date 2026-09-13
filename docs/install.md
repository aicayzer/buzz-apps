# Installation and operation

## Choose where it runs

Run one Buzz Apps service on a machine that can reach your Buzz relay and receive HTTPS requests from GitHub. Native Node.js is the primary installation; Docker packages the same service. Keep it running independently of your terminal. Each enabled app owns its identity and credentials; shared setup does not enable any apps.

Use Node.js 24 LTS and npm. Native services support macOS launchd and Linux systemd. Linux needs a user service manager; enable lingering for your service account if it must survive logout. macOS LaunchAgents run in the user's login session and survive SSH disconnects, but require that login session after a reboot.

```sh
npm install --global buzz-apps
buzz-apps setup
buzz-apps enable github
```

Until the initial npm publication, download the `.tgz` and `SHA256SUMS` from the release, verify its checksum, then run `npm install --global ./buzz-apps-VERSION.tgz`. Release candidates use the `next` npm tag after publication. This is the same npm installation, not a separate installer.

`setup` records your relay URL, public service URL and Buzz operator public key. Its default configuration is `~/.config/buzz-apps/config.json`; persistent data defaults to `~/.local/share/buzz-apps/data`. Override the file with `--config /absolute/path/config.json`. The service writes configuration as mode `0600`; keep the containing directory private. Do not commit either configuration or data.

## Enable GitHub

`enable github` creates a dedicated Buzz keypair, or accepts an existing one. Add its public key to your relay and invite the bot to the channels it should serve. The private registration link printed by the command is for the installer only.

```sh
buzz-apps service install
buzz-apps service start
```

Expose the configured HTTP port through HTTPS. Route your chosen public URL to this service; GitHub must reach webhook and OAuth callback routes. Open the private registration link to create your own GitHub App, then install that app on selected repositories. Keep its permissions as requested by the manifest. Restart the service after configuration changes and run `buzz-apps doctor`.

In Buzz, mention the bot and send `signin` to link your GitHub account. Sign-in opens GitHub in your browser and returns to the service. Installation credentials handle background notifications; user actions use that person's linked account. Subscribing a private repository permits notifications to everyone in the selected Buzz channel.

## Set up with an agent

Every command supports `--config`; status and configuration commands support `--json`. Missing values in a non-interactive shell produce an error instead of a prompt. An agent can provide shared configuration through `setup --input /private/shared.json`, or flags:

```sh
buzz-apps --json setup --relay wss://buzz.example.org --public-url https://apps.example.org --admin YOUR_BUZZ_PUBLIC_KEY
buzz-apps --json enable github --input /private/github.json
```

The optional app input accepts `botKey` (hexadecimal), `authTag` and `github` credentials. Omit `botKey` to create a new identity. The `github` object contains `appId`, `privateKey`, `clientId`, `clientSecret` and `webhookSecret`; most people should use browser registration instead. The environment variable `BUZZ_APPS_GITHUB_BOT_KEY` also supplies an existing identity. Never pass credentials directly in command arguments or send them into Buzz.

A secrets manager can populate environment variables, render the external configuration, or provide a `secretCommand` array. That command runs directly without a shell and returns a JSON object containing secret fields such as `encryptionKey`, `identities` and `github`. Keep the command and its account access outside the repository. No particular secrets manager is required. GitHub may require a person to complete consent, organisation approval or MFA; an agent should report that exact remaining step.

## Check and control

```sh
buzz-apps status
buzz-apps doctor
buzz-apps service restart
buzz-apps disable github
```

`service install --label org.example.buzz-apps` sets a custom native service identifier; subsequent controls and updates reuse it.

`status` checks the local process. `doctor` checks readiness through the running service and reports configured identities without private keys. A live HTTP process alone does not establish relay admission or GitHub access. `disable` preserves configuration and data; restart to apply it. `start` runs in the foreground for development or container use.

## Update and recover

Apps and the service release together. Updates are deliberate:

```sh
buzz-apps update
buzz-apps update --version 0.1.0-rc.1
buzz-apps rollback
```

The CLI recognises the global npm installation in your active npm prefix. It stops the native service, saves the installed package, configuration and database together, installs into that same prefix, and starts the service. A failed health check restores the matching backup. Backups remain under the service's private data parent for inspection; rollback preserves displaced data before restoring. Do not change Node.js major versions between an update and its rollback because native dependencies belong to the original Node.js runtime.

Do not run `npm update --global` against a running service: it skips paired data backups. For foreground deployments, stop the process, back up configuration and the whole data directory, update the package, then restart. Restore the matching package and data together if recovery is needed. Check release notes for migrations and compatibility before upgrading.

## Docker

Use the supplied `compose.yaml` with a pinned release version. Create external configuration first, then set `host` to `0.0.0.0`, `port` to `8080` and `dataDir` to `/data` for the container. Set `BUZZ_APPS_CONFIG_DIR` to its external directory and ensure container user UID 1000 can read and update it. The directory is writable because GitHub registration saves credentials there.

```sh
export BUZZ_APPS_CONFIG_DIR=/absolute/private/buzz-apps-config
export BUZZ_APPS_VERSION=0.1.0-rc.1
docker compose up -d
```

The named volume holds the database. Before changing the pinned image version, stop the container and back up both that volume and configuration. Pull and start the new version, then check `docker compose exec buzz-apps node dist/src/cli/main.js doctor`. Roll back the image and matching data/configuration backup together. The native `update` and `rollback` commands deliberately reject Docker installations.
