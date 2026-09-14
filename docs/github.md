# GitHub

GitHub notifications and actions in Buzz, using a dedicated GitHub bot identity. The integration targets GitHub.com. It uses GitHub's Slack app as its behavioural reference; Buzz messages and browser forms replace Slack-specific presentation and controls.

## Connect and subscribe

An administrator runs `buzz-apps enable github`, registers a GitHub App through the setup link and installs it on the chosen repositories. Add the bot to a Buzz channel. Each person then uses `@GitHub signin` to connect their own GitHub account.

A channel owner or administrator can subscribe:

```text
@GitHub subscribe OWNER/REPO
@GitHub subscribe OWNER
@GitHub subscribe OWNER/REPO reviews comments
@GitHub subscribe OWNER/REPO commits:release/*
@GitHub subscribe OWNER/REPO +label:"ready for review"
@GitHub subscribe OWNER/REPO workflows:{name:CI,event:push,branch:main}
@GitHub subscribe list features
@GitHub unsubscribe OWNER/REPO comments
@GitHub unsubscribe OWNER/REPO
```

Subscriptions publish to the whole channel, including notifications from private repositories. Subscribing is the approval; there is no separate approval prompt or check that every channel member has GitHub access. The configuring person must have GitHub access and channel management authority. An organisation subscription covers public repositories available to the installation and a snapshot of private repositories the configuring person can access. Repeat the subscribe command to refresh that snapshot when adding private repositories.

The defaults are issues, pull requests, commits to the default branch, releases and deployments. Supplying features when creating a subscription selects those features instead. Adding features to an existing subscription keeps its other features. A new label filter replaces the previous label filter.

| Notification             | Behaviour                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issues and pull requests | A parent message reflects the latest GitHub state; subsequent changes appear in its thread. Closing, reopening and marking ready for review stay in the thread by default; lifecycle broadcasts are an explicit opt-in. |
| Comments and reviews     | Optional thread replies, with optional channel broadcasts. Edited comments update their existing message; deleted comments replace its text.                                                                            |
| Commits                  | Default branch by default; explicit branches or glob patterns supported. Up to eight commits appear in a message, with a link to the complete comparison.                                                               |
| Workflows                | Run status updates edit one parent. Unfiltered subscriptions show pull request runs targeting the default branch. Name, event, branch and actor filters are supported.                                                  |
| Releases                 | Published releases, including prereleases.                                                                                                                                                                              |
| Deployments              | Environment, ref and latest deployment status.                                                                                                                                                                          |
| Branches                 | Optional branch creation and deletion messages.                                                                                                                                                                         |
| Discussions              | Optional discussion updates and comments.                                                                                                                                                                               |

`@GitHub settings` opens a private browser link for threading, lifecycle broadcasts, review broadcasts, comment broadcasts and previews. Subscription filters remain available through commands.

## Act as yourself

```text
@GitHub open
@GitHub issue OWNER/REPO#123 comment Your comment
@GitHub issue OWNER/REPO#123 edit
@GitHub issue OWNER/REPO#123 close
@GitHub issue OWNER/REPO#123 reopen
@GitHub workflow OWNER/REPO 123456 rerun
@GitHub workflow OWNER/REPO 123456 rerun failed debug
@GitHub deployment OWNER/REPO 123456 approve production
@GitHub deployment OWNER/REPO 123456 reject production
@GitHub signout
```

Issue creation and editing use expiring browser forms. Writes use the connected person's GitHub token and GitHub's permission checks. Workflow reruns and deployment reviews require the same authority as on GitHub. Signing out disconnects the person; channel notifications continue using installation credentials.

A lost response to a write is treated as uncertain. The service journals the operation and does not automatically repeat it. Issue creation and comment creation include an invisible operation marker so a replay can find an already successful write. State changes can be reconciled against GitHub. An unresolved write requires checking GitHub before issuing a new command.

## Previews and reminders

Pasted GitHub links can show repositories, user and organisation profiles, issues, pull requests, comments, reviews and selected code lines. Public previews can work without a linked account. Private previews use the posting person's access. A private preview appears in a channel only when the repository is covered by an enabled subscription; otherwise it goes privately to the sender. There are at most three previews per message and forty code lines per preview. Buzz’s explicit `link-preview: none` preference is honoured. Quoted examples, fenced or indented code, and inline code do not trigger automatic previews.

```text
@GitHub reminders
@GitHub reminders list
@GitHub reminders REMINDER_ID
@GitHub reminders delete REMINDER_ID
```

Review reminders support personal or channel destinations, repositories, timezone, weekdays, time, a review team, draft and approval exclusions, minimum age, staleness, a required label and a title filter. Channel reminders require channel management authority. Schedules persist across restarts; missed reminders catch up within a day and consolidate missed occurrences. Browser preview lets you check the matching pull requests before saving.

## Compatibility boundaries

The reference is the [GitHub Slack integration documentation](https://github.com/integrations/slack), reviewed in September 2026. Behaviour is implemented directly against GitHub's APIs; this is not a repackaged Slack app.

- **Buzz controls differ.** Use a real bot mention. Slack slash commands, interactive buttons, coloured attachments, columns and ephemeral replies are replaced with messages, threads and private browser links.
- **Identity links are explicit.** GitHub accounts are linked through sign-in. Explicit assignments, review requests and direct mentions in authored comments or newly opened issues can notify linked people. Buzz mentions use their Buzz profile display name and native mention presentation. Release credits and quoted/code examples do not cause pings, and ordinary actor attribution links to the GitHub profile. People without a linked account cannot receive a Buzz mention.
- **Scope is GitHub.com.** GitHub Enterprise Server and Slack administration-specific controls are not implemented.
- **Bounded output stays readable.** Long descriptions, commit lists, code selections and reminder results are summarised with links to GitHub. Reminder search observes GitHub's search limits.
- **Private messages depend on Buzz access controls.** They are not end-to-end encrypted. Never paste credentials into a channel or DM.

See [architecture](architecture.md) for delivery guarantees and [installation](install.md) for installation and updates.

Label changes, title/body edits and pull request synchronisation update the existing notification without adding a thread reply. Significant state changes, comments and reviews retain their thread behaviour.

## Setup overview and activity summaries

`@GitHub status` sends a private overview of the connected account, this channel’s subscriptions, other channels the caller can manage, and their own or manageable channel summaries. Channel names link to Buzz and repository names link to GitHub. No other person’s private summaries are listed.

`@GitHub summaries` opens a private form. Create daily and weekly schedules independently; each is a separate message. Use `summaries NAME` to edit, `summaries list` to inspect, `summaries preview NAME` for a private preview, and `summaries delete NAME` to remove. Channel summaries must be configured from their destination channel by an owner or administrator. Choosing a channel explicitly permits sharing the configured activity, including private activity, with its members.

Scopes:

- **Personal:** GitHub contribution statistics, including totals, commits, issues, pull requests, reviews and top repositories by commit contributions. Weekly messages compare contribution totals with the previous week. These follow GitHub’s contribution rules and the linked account’s visibility, not every event or commit on every branch.
- **Repositories:** activity for one repository or a group: PRs opened/merged, issues opened/closed, default-branch commits and submitted reviews. Outstanding reviews and failed workflow runs provide context.
- **Organisation:** a snapshot of the repositories approved at setup. Newly accessible repositories are not silently added; edit and save to refresh approval. Removed access blocks delivery until reviewed.

Daily reports cover the previous complete local day. Weekly reports cover the seven complete local days before delivery. Timezones inherit the shared service setting unless overridden. Empty reports can be skipped or delivered; incomplete repository results are labelled partial, never silently counted as zero. Repository work is bounded to 100 repositories and 1,000 commits/updated PRs per repository per period; exceeding a bound marks that repository unavailable.

Schedules survive restarts and missed runs catch up with the latest due period, rather than flooding the channel with every missed day. Failed deliveries retain their period and deduplication key, retry with backoff, and affect readiness until resolved. Disabling/deleting or editing a summary clears its previous failure state.

### Configure with readable arguments

```text
@GitHub summaries set daily --cadence daily --scope personal --time 09:00 --destination here
@GitHub summaries set weekly --cadence weekly --scope repositories --repos owner/repo,owner/other --day monday --time 09:00 --destination private
@GitHub summaries disable daily
@GitHub summaries enable daily
```

Missing options open a private form with the supplied choices filled in. `--destination here` means the channel where you issued the command; `private` means you alone. Use `--scope organisation --org OWNER` for an organisation, `--skip-empty false` to include quiet periods, and `--timezone Europe/London` to override the shared timezone (`default` removes an override). New weekly schedules default to Monday and empty periods are skipped. Updating an existing name preserves unspecified options. `summaries help` lists the arguments. JSON remains accepted for compatibility, but is not needed.

### Quiet agent configuration

The local CLI sends the same command directly to the running service, without publishing setup messages to Buzz:

```sh
buzz-apps github --key-file /secure/buzz-person.key --channel CHANNEL_ID -- summaries set daily --cadence daily --scope personal --time 09:00 --destination here
buzz-apps github --key-file /secure/buzz-person.key --channel CHANNEL_ID -- summaries list
```

The key file contains only the linked person's hex Buzz private key. Never put that key in a command argument or repository. The request is signed by that person; it does not impersonate an arbitrary public key. The service applies the same GitHub account and destination-channel permissions as Buzz and browser forms. It uses a local socket restricted to the service user, with expiring, replay-protected requests; it is not exposed through the public HTTP endpoint. The service must be running on the same machine. Output, including any private form link, returns to the terminal. Only summary commands and status are supported on this route; it does not publish arbitrary messages or GitHub writes.

### Personal contribution coverage

A GitHub App user token can return calendar totals beyond the repositories available to the app, while its detailed breakdown is narrower. The summary labels that limitation. For a full personal breakdown, an operator can supply `githubContributionTokens`, a map from Buzz public key to a GitHub personal token, through external configuration or the secret provider. The service verifies that the token belongs to the same linked GitHub account on every summary request. This optional credential is used only for personal contribution reads, never normal commands, repository access approvals or writes. Keep tokens out of Buzz messages and version control.

The quiet local interface requires management permission for the supplied Buzz channel, including read-only status commands. The key identifies the linked person; filesystem access alone does not authorise channel access.
