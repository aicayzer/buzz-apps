# Buzz Apps

[![npm version](https://img.shields.io/npm/v/buzz-apps/next)](https://www.npmjs.com/package/buzz-apps)
[![CI](https://github.com/aicayzer/buzz-apps/actions/workflows/ci.yml/badge.svg)](https://github.com/aicayzer/buzz-apps/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Community apps for [Buzz](https://github.com/block/buzz), starting with GitHub. Run one service alongside your Buzz relay and enable the apps you need. Each app has its own bot identity and provider credentials.

The GitHub app brings repository notifications and commands into Buzz: subscriptions, issue and pull request updates, Actions, deployments, previews and review reminders. Use a real mention of the bot followed by a command:

```text
@GitHub signin
@GitHub subscribe owner/repository
@GitHub subscribe list
@GitHub help
```

Behaviour follows GitHub's Slack integration where Buzz supports it. Messages use Buzz Markdown, links and threads; forms open in a browser. See the [GitHub guide](docs/github.md) for commands and compatibility.

## Install

Use Node.js 24 LTS, a Buzz relay and a public HTTPS address for callbacks and webhooks. Install the npm package, configure the shared service, then enable GitHub:

```sh
npm install --global buzz-apps
buzz-apps setup
buzz-apps enable github
buzz-apps service install
buzz-apps service start
buzz-apps doctor
```

During release-candidate evaluation, use `buzz-apps@next` or install the `.tgz` from [Releases](https://github.com/aicayzer/buzz-apps/releases).

Setup creates external configuration. Enabling GitHub creates or reuses its Buzz identity and provides a private link to register your own GitHub App. Individual users sign in from Buzz. [Installation](docs/install.md) covers agents, existing keys, Docker, updates and recovery. n8n and the GitHub CLI are not required.

## Contribute

Fixes and new apps are welcome through pull requests. Suggest apps in Issues; propose substantial changes to existing behaviour before implementation. Contributors maintain their accepted apps. Read [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).

For agent personas, skills, workflows and reusable resources, see the independent [Buzz Cookbook](https://github.com/aicayzer/buzz-cookbook). Either repository can be used on its own.

MIT licensed. This is a community project, not an official GitHub or Block integration.
