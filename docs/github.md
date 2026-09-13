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

| Notification             | Behaviour                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issues and pull requests | A parent message reflects the latest GitHub state; subsequent changes appear in its thread. Closing, reopening and marking ready for review can broadcast a thread update. |
| Comments and reviews     | Optional thread replies, with optional channel broadcasts. Edited comments update their existing message; deleted comments replace its text.                               |
| Commits                  | Default branch by default; explicit branches or glob patterns supported. Up to eight commits appear in a message, with a link to the complete comparison.                  |
| Workflows                | Run status updates edit one parent. Unfiltered subscriptions show pull request runs targeting the default branch. Name, event, branch and actor filters are supported.     |
| Releases                 | Published releases, including prereleases.                                                                                                                                 |
| Deployments              | Environment, ref and latest deployment status.                                                                                                                             |
| Branches                 | Optional branch creation and deletion messages.                                                                                                                            |
| Discussions              | Optional discussion updates and comments.                                                                                                                                  |

`@GitHub settings` opens a private browser link for threading, review broadcasts, comment broadcasts and previews. Subscription filters remain available through commands.

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

Pasted GitHub links can show repositories, user and organisation profiles, issues, pull requests, comments, reviews and selected code lines. Public previews can work without a linked account. Private previews use the posting person's access. A private preview appears in a channel only when the repository is covered by an enabled subscription; otherwise it goes privately to the sender. There are at most three previews per message and forty code lines per preview.

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
- **Identity links are explicit.** GitHub accounts are linked through sign-in. Linked reviewers, assignees and requested team members can be mentioned in Buzz; people without a link cannot receive a Buzz mention.
- **Scope is GitHub.com.** GitHub Enterprise Server and Slack administration-specific controls are not implemented.
- **Bounded output stays readable.** Long descriptions, commit lists, code selections and reminder results are summarised with links to GitHub. Reminder search observes GitHub's search limits.
- **Private messages depend on Buzz access controls.** They are not end-to-end encrypted. Never paste credentials into a channel or DM.

See [architecture](architecture.md) for delivery guarantees and [installation](install.md) for installation and updates.

Label changes, title/body edits and pull request synchronisation update the existing notification without adding a thread reply. Significant state changes, comments and reviews retain their thread behaviour.
