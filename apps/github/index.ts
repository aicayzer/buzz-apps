import { summaryInput, SUMMARY_HELP } from './summary-command.js';
import { effectiveTimezone, timezoneLabel } from '../../src/core/timezone.js';
import {
  channelLink,
  repoLink,
  saveSummary,
  summaryText,
  summarySchedule,
  deliverSummaries,
  type Summary,
} from './summaries.js';
import { GithubInputError } from './errors.js';
import { createHash } from 'node:crypto';
import type {
  AppContext,
  BuzzApp,
  Message,
  Subscription,
} from '../../src/core/types.js';
import { GithubApi, friendlyError } from './api.js';
import {
  DEFAULT_FEATURES,
  parseFeatures,
  subscriptionKey,
  targetParts,
} from './subscriptions.js';
import { deliverWebhook } from './notifications.js';
import { deliverReminders, saveReminder, type Reminder } from './reminders.js';
import { previewLinks } from './previews.js';

export const HELP = `**GitHub**\n\n- \`@GitHub status\`\n- \`@GitHub summaries\`\n\n- \`@GitHub subscribe OWNER/REPO [features]\`\n- \`@GitHub unsubscribe OWNER/REPO [features]\`\n- \`@GitHub subscribe list [features]\`\n- \`@GitHub settings\`\n- \`@GitHub open\`\n- \`@GitHub issue OWNER/REPO#NUMBER comment TEXT|edit|close|reopen\`\n- \`@GitHub workflow OWNER/REPO RUN_ID rerun [failed] [debug]\`\n- \`@GitHub deployment OWNER/REPO RUN_ID approve|reject ENVIRONMENT\`\n- \`@GitHub reminders\`\n- \`@GitHub signout\`\n\n- **Default notifications:** issues, pull requests, default-branch commits, releases and deployments.\n- **Optional notifications:** workflows, reviews, comments, branches and discussions.\n- **Filters:** \`commits:BRANCH\`, \`+label:LABEL\`, \`name=WORKFLOW\`, \`event=EVENT\`, \`branch=BRANCH\` and \`actor=LOGIN\`.\n- **Organisations:** use \`OWNER\` to subscribe to an organisation.\n- **Private repositories:** subscriptions publish to the whole channel.\n\n**Account**\n- Use \`@GitHub signin\` to connect or reconnect your account.`;

export function commandText(
  message: Message,
  botPubkey: string,
): string | undefined {
  if (!message.tags.some((tag) => tag[0] === 'p' && tag[1] === botPubkey))
    return undefined;
  return message.content
    .replace(
      /^\s*(?:@GitHub(?:\s*(?:\(bot\)|bot))?|nostr:(?:npub|nprofile)\w+|\[[^\]]+\]\(nostr:[^)]+\))(?=\s|[:,]|$)[:,]?\s*/i,
      '',
    )
    .trim();
}
export class GithubApp implements BuzzApp {
  readonly id = 'github';
  readonly api: GithubApi;
  constructor(readonly context: AppContext) {
    this.api = new GithubApi(context);
  }
  subscriptions(channel?: string): Subscription[] {
    return this.context.store
      .list<Subscription>('subscriptions')
      .map((row) => row.value)
      .filter((sub) => !channel || sub.channel === channel);
  }
  async manage(message: Message): Promise<void> {
    if (!(await this.context.buzz.canManage(message.channel, message.author)))
      throw new GithubInputError(
        'A channel owner or administrator must configure this channel.',
      );
  }
  private async reply(message: Message, text: string): Promise<void> {
    await this.context.buzz.send(message.channel, text, {
      root: message.root ?? message.id,
      dedupKey: `github:command:${message.id}:reply`,
    });
  }
  private async notify(message: Message, text: string): Promise<void> {
    await this.context.buzz.dm(message.author, text, {
      dedupKey: `github:command:${message.id}:private`,
    });
  }
  private async form(
    purpose:
      'signin' | 'settings' | 'open' | 'reminders' | 'issue-edit' | 'summaries',
    message: Message,
    data: Record<string, unknown> = {},
    acknowledgement = 'I sent you a private link.',
  ): Promise<void> {
    if (!this.context.link)
      throw new GithubInputError(
        'Browser forms are unavailable: check the service public URL configuration.',
      );
    const url = await this.context.link(purpose, message, data);
    await this.notify(
      message,
      `[${{ signin: 'Sign in to GitHub', settings: 'Change notification settings', open: 'Create an issue', reminders: 'Configure review reminders', 'issue-edit': 'Edit the issue', summaries: 'Configure activity summaries' }[purpose]}](${url})\n\nThis link expires. Open it yourself; do not forward it.`,
    );
    await this.reply(message, acknowledgement);
  }
  async onMessage(message: Message): Promise<void> {
    if (message.author === this.context.buzz.pubkey) return;
    const text = commandText(message, this.context.buzz.pubkey);
    if (text === undefined) {
      await previewLinks(
        this.context,
        this.api,
        message,
        this.subscriptions(message.channel),
      );
      return;
    }
    let command = 'help';
    try {
      const parsed = tokenize(text);
      command = parsed[0] ?? 'help';
      const tokens = parsed.slice(1);
      switch (command.toLowerCase()) {
        case 'help':
          await this.reply(
            message,
            this.context.store.account(message.author)
              ? HELP.replace(
                  '- Use `@GitHub signin` to connect or reconnect your account.',
                  '- Your GitHub account is connected. Use `@GitHub signout` to disconnect.',
                )
              : HELP,
          );
          break;
        case 'signin':
          await this.form('signin', message);
          break;
        case 'signout':
          this.context.store.removeAccount(message.author);
          await this.notify(
            message,
            'Your GitHub account is disconnected from Buzz Apps. Existing channel subscriptions continue with the installation credentials.',
          );
          break;
        case 'subscribe':
          await this.subscribe(message, tokens);
          break;
        case 'unsubscribe':
          await this.unsubscribe(message, tokens);
          break;
        case 'settings':
          await this.manage(message);
          await this.form(
            'settings',
            message,
            tokens[0] ? { target: tokens[0] } : {},
          );
          break;
        case 'open':
          await this.api.account(message.author);
          await this.form('open', message, {
            source: message.content,
            sourceEvent: message.root ?? message.id,
            ...(tokens[0] ? { target: tokens[0] } : {}),
          });
          break;
        case 'status':
          await this.notify(message, await this.status(message));
          await this.reply(
            message,
            'Your GitHub setup has been sent privately.',
          );
          break;
        case 'summaries':
          await this.summaries(message, tokens);
          break;
        case 'reminders':
          await this.reminders(message, tokens);
          break;
        case 'issue':
          await this.issue(message, tokens);
          break;
        case 'workflow':
          await this.workflow(message, tokens);
          break;
        case 'deployment':
          await this.deployment(message, tokens);
          break;
        default:
          await this.reply(
            message,
            `Unknown command: ${command}. Use @GitHub help.`,
          );
      }
    } catch (error) {
      this.context.log.warn(
        { operation: command, status: (error as { status?: number }).status },
        'GitHub command failed',
      );
      await this.notify(message, friendlyError(error));
    }
  }
  async subscribe(message: Message, tokens: string[]): Promise<void> {
    if (tokens[0] === 'list') {
      const list = this.subscriptions(message.channel);
      await this.reply(
        message,
        list.length
          ? list
              .map(
                (sub) =>
                  `- ${repoLink(sub.target)}${tokens[1] === 'features' ? `: ${sub.features.join(', ')}${Object.keys(sub.settings.filters ?? {}).length ? `; filters: ${JSON.stringify(sub.settings.filters)}` : ''}` : ''}`,
              )
              .join('\n')
          : 'This channel has no GitHub subscriptions.',
      );
      return;
    }
    await this.manage(message);
    const [target, ...featureTokens] = tokens;
    if (!target)
      throw new GithubInputError(
        'Use @GitHub subscribe OWNER/REPO [features].',
      );
    targetParts(target);
    await this.api.authorised(message.author, target);
    const approvedRepositories = !target.includes('/')
      ? await this.api.approvedRepositories(message.author, target)
      : undefined;
    const key = subscriptionKey(message.channel, target);
    const existing = this.context.store.get<Subscription>('subscriptions', key);
    const parsed = parseFeatures(featureTokens);
    const features = [
      ...new Set([
        ...(existing?.features ??
          (parsed.features.length ? [] : DEFAULT_FEATURES)),
        ...parsed.features,
      ]),
    ];
    const subscription: Subscription = {
      channel: message.channel,
      target: target.toLowerCase(),
      features,
      createdBy: existing?.createdBy ?? message.author,
      settings: {
        ...existing?.settings,
        ...(approvedRepositories ? { approvedRepositories } : {}),
        filters: {
          ...((existing?.settings.filters as object) ?? {}),
          ...parsed.filters,
        },
      },
    };
    this.context.store.set('subscriptions', key, subscription);
    await this.reply(
      message,
      `**Notifications enabled**\n\n- **Repository:** ${repoLink(target)}\n- **Channel:** ${await channelLink(this.context, message.channel)}\n- **Events:** ${features.map((f) => (f === 'pulls' ? 'pull requests' : f)).join(', ')}.\n\nPrivate repository notifications are shared with everyone in this channel.`,
    );
  }
  async unsubscribe(message: Message, tokens: string[]): Promise<void> {
    await this.manage(message);
    const [target, ...features] = tokens;
    if (!target)
      throw new GithubInputError(
        'Use @GitHub unsubscribe OWNER/REPO [features].',
      );
    const key = subscriptionKey(message.channel, target);
    const subscription = this.context.store.get<Subscription>(
      'subscriptions',
      key,
    );
    if (!subscription)
      throw new GithubInputError(
        'This channel is not subscribed to that repository or organisation.',
      );
    if (!features.length) this.context.store.delete('subscriptions', key);
    else {
      const parsed = parseFeatures(features);
      subscription.features = subscription.features.filter(
        (feature) => !parsed.features.includes(feature),
      );
      if (features.some((feature) => feature.startsWith('+label:'))) {
        const filters = subscription.settings.filters as
          Record<string, unknown> | undefined;
        if (filters) delete filters.label;
      }
      this.context.store.set('subscriptions', key, subscription);
    }
    await this.reply(
      message,
      `**Notifications updated**\n${repoLink(target)} in ${await channelLink(this.context, message.channel)}.`,
    );
  }
  async updateSettings(
    message: Message,
    target: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    await this.manage(message);
    const key = subscriptionKey(message.channel, target);
    const subscription = this.context.store.get<Subscription>(
      'subscriptions',
      key,
    );
    if (!subscription)
      throw new GithubInputError('Subscribe to this repository first.');
    const allowed = [
      'threading',
      'broadcastUpdates',
      'broadcastReviews',
      'broadcastComments',
      'previews',
    ];
    if (
      Object.entries(settings).some(
        ([key, value]) => !allowed.includes(key) || typeof value !== 'boolean',
      )
    )
      throw new GithubInputError(
        'Settings accept threading, broadcastUpdates, broadcastReviews, broadcastComments and previews as booleans.',
      );
    subscription.settings = { ...subscription.settings, ...settings };
    this.context.store.set('subscriptions', key, subscription);
  }
  async createIssue(
    message: Message,
    input: { target: string; title: string; body?: string },
  ): Promise<string> {
    const { owner, repo } = targetParts(input.target);
    if (!repo || !input.title.trim())
      throw new GithubInputError('A repository and issue title are required.');
    const client = await this.api.user(message.author);
    const marker = `<!-- buzz-apps:${this.writeKey(message, 'create-issue', input)} -->`;
    return this.write(
      message,
      'create-issue',
      input,
      async () => {
        const result = await client.request(
          'POST /repos/{owner}/{repo}/issues',
          {
            owner,
            repo,
            title: input.title,
            body: `${input.body ?? ''}\n\n${marker}`,
          },
        );
        return result.data.html_url;
      },
      async (at) => {
        const items = await client.paginate(
          'GET /repos/{owner}/{repo}/issues',
          {
            owner,
            repo,
            state: 'all',
            since: new Date(at - 60000).toISOString(),
            per_page: 100,
          },
        );
        return items.find((item) => item.body?.includes(marker))?.html_url;
      },
    );
  }
  async editIssue(
    message: Message,
    input: { target: string; number: number; title?: string; body?: string },
  ): Promise<string> {
    const { owner, repo } = targetParts(input.target);
    if (!repo || !Number.isSafeInteger(input.number) || input.number < 1)
      throw new GithubInputError('Provide a repository and issue number.');
    const client = await this.api.user(message.author);
    return this.write(message, 'edit-issue', input, async () => {
      const response = await client.request(
        'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
        {
          owner,
          repo,
          issue_number: input.number,
          title: input.title,
          body: input.body,
        },
      );
      return response.data.html_url;
    });
  }
  private async reminders(message: Message, tokens: string[]): Promise<void> {
    await this.api.account(message.author);
    const rows = this.context.store
      .list<Reminder>('github:reminders')
      .map((row) => row.value)
      .filter((reminder) => reminder.author === message.author);
    if (tokens[0] === 'list') {
      await this.notify(
        message,
        rows.length
          ? rows
              .map(
                (reminder) =>
                  `- **${reminder.id}**: ${reminder.enabled ? 'Enabled' : 'Disabled'}, ${reminder.time} (${timezoneLabel(effectiveTimezone(this.context.config, reminder.timezone))}), ${reminder.channel ? 'channel' : 'personal'}`,
              )
              .join('\n')
          : 'You have no review reminders.',
      );
      return;
    }
    if (tokens[0] === 'delete') {
      if (!tokens[1] || !rows.some((reminder) => reminder.id === tokens[1]))
        throw new GithubInputError(
          'Use reminders delete ID with one of your reminder IDs.',
        );
      this.context.store.delete(
        'github:reminders',
        `${message.author}:${tokens[1]}`,
      );
      await this.notify(message, 'Review reminder deleted.');
      return;
    }
    const reminder = tokens[0]
      ? rows.find((item) => item.id === tokens[0])
      : undefined;
    if (tokens[0] && !reminder)
      throw new GithubInputError(
        'No reminder with that ID. Use @GitHub reminders list.',
      );
    await this.form(
      'reminders',
      message,
      reminder ? { id: reminder.id, reminder } : {},
    );
  }
  async configureReminder(message: Message, reminder: Reminder): Promise<void> {
    await saveReminder(this.context, this.api, message, reminder);
  }
  private writeKey(message: Message, operation: string, data: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify([message.id, operation, data]))
      .digest('hex');
  }
  private async write<T>(
    message: Message,
    operation: string,
    data: unknown,
    action: () => Promise<T>,
    reconcile?: (at: number) => Promise<T | undefined>,
  ): Promise<T> {
    const key = this.writeKey(message, operation, data);
    const previous = this.context.store.get<{
      state: string;
      value?: T;
      at: number;
    }>('github:writes', key);
    if (previous?.state === 'done') return previous.value as T;
    if (previous && reconcile) {
      const recovered = await reconcile(previous.at);
      if (recovered !== undefined) {
        this.context.store.set('github:writes', key, {
          state: 'done',
          value: recovered,
        });
        return recovered;
      }
    }
    if (previous)
      throw new GithubInputError(
        'This action has an uncertain result. Check GitHub before submitting another command; it has not been retried automatically.',
      );
    this.context.store.set('github:writes', key, {
      state: 'pending',
      operation,
      at: Date.now(),
    });
    try {
      const value = await action();
      this.context.store.set('github:writes', key, { state: 'done', value });
      return value;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status && status >= 400 && status < 500)
        this.context.store.delete('github:writes', key);
      throw error;
    }
  }
  private async issue(message: Message, tokens: string[]): Promise<void> {
    const match = /^([^/]+\/[^#]+)#(\d+)$/.exec(tokens[0] ?? '');
    if (!match)
      throw new GithubInputError(
        'Use @GitHub issue OWNER/REPO#NUMBER comment TEXT|edit|close|reopen.',
      );
    const target = match[1];
    const issue_number = Number(match[2]);
    const { owner, repo } = targetParts(target);
    const action = tokens[1];
    if (action === 'edit') {
      await this.api.account(message.author);
      await this.form('issue-edit', message, { target, number: issue_number });
      return;
    }
    if (!['comment', 'close', 'reopen'].includes(action))
      throw new GithubInputError(
        'Issue actions: comment TEXT, edit, close, reopen.',
      );
    const client = await this.api.user(message.author);
    const body = tokens.slice(2).join(' ');
    if (action === 'comment' && !body)
      throw new GithubInputError('Provide the comment text.');
    const marker = `<!-- buzz-apps:${this.writeKey(message, `issue-${action}`, { target, issue_number, body })} -->`;
    const url = await this.write(
      message,
      `issue-${action}`,
      { target, issue_number, body },
      async () => {
        if (action === 'comment')
          return (
            await client.request(
              'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
              {
                owner,
                repo: repo!,
                issue_number,
                body: `${body}\n\n${marker}`,
              },
            )
          ).data.html_url;
        return (
          await client.request(
            'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
            {
              owner,
              repo: repo!,
              issue_number,
              state: action === 'close' ? 'closed' : 'open',
            },
          )
        ).data.html_url;
      },
      async (at) => {
        if (action === 'comment') {
          const comments = await client.paginate(
            'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
            {
              owner,
              repo: repo!,
              issue_number,
              since: new Date(at - 60000).toISOString(),
              per_page: 100,
            },
          );
          return comments.find((comment) => comment.body?.includes(marker))
            ?.html_url;
        }
        const current = await client.request(
          'GET /repos/{owner}/{repo}/issues/{issue_number}',
          { owner, repo: repo!, issue_number },
        );
        return current.data.state === (action === 'close' ? 'closed' : 'open')
          ? current.data.html_url
          : undefined;
      },
    );
    await this.notify(
      message,
      `[Issue ${action === 'comment' ? 'comment added' : action === 'close' ? 'closed' : 'reopened'}](${url})`,
    );
  }
  private async workflow(message: Message, tokens: string[]): Promise<void> {
    const [target, id, action, ...flags] = tokens;
    const { owner, repo } = targetParts(target ?? '');
    const run_id = Number(id);
    if (
      !repo ||
      !Number.isSafeInteger(run_id) ||
      run_id < 1 ||
      action !== 'rerun' ||
      flags.some((flag) => !['failed', 'debug'].includes(flag))
    )
      throw new GithubInputError(
        'Use @GitHub workflow OWNER/REPO RUN_ID rerun [failed] [debug].',
      );
    const client = await this.api.user(message.author);
    await this.write(message, 'workflow-rerun', tokens, async () => {
      await client.request(
        flags.includes('failed')
          ? 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs'
          : 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun',
        { owner, repo, run_id, enable_debug_logging: flags.includes('debug') },
      );
      return true;
    });
    await this.notify(
      message,
      `[Workflow rerun requested](https://github.com/${target}/actions/runs/${run_id}).`,
    );
  }
  private async deployment(message: Message, tokens: string[]): Promise<void> {
    const [target, id, action, ...environment] = tokens;
    const { owner, repo } = targetParts(target ?? '');
    const run_id = Number(id);
    if (
      !repo ||
      !Number.isSafeInteger(run_id) ||
      run_id < 1 ||
      !['approve', 'reject'].includes(action) ||
      !environment.length
    )
      throw new GithubInputError(
        'Use @GitHub deployment OWNER/REPO RUN_ID approve|reject ENVIRONMENT.',
      );
    const client = await this.api.user(message.author);
    const pending = await client.request(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments',
      { owner, repo, run_id },
    );
    const deployment = pending.data.find(
      (item) => item.environment.name === environment.join(' '),
    );
    if (!deployment?.environment.id || !deployment.current_user_can_approve)
      throw new GithubInputError(
        'You cannot review this pending environment deployment.',
      );
    await this.write(message, 'deployment-review', tokens, async () => {
      await client.request(
        'POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments',
        {
          owner,
          repo,
          run_id,
          environment_ids: [Number(deployment.environment.id!)],
          state: action === 'approve' ? 'approved' : 'rejected',
          comment: 'Reviewed through Buzz Apps.',
        },
      );
      return true;
    });
    await this.notify(
      message,
      `Deployment ${action === 'approve' ? 'approved' : 'rejected'}.`,
    );
  }
  async status(message: Message): Promise<string> {
    const account = this.context.store.account(message.author);
    const lines = [
      '**Your GitHub setup**',
      '',
      '👤 **Account**',
      account
        ? `Connected as **${account.login}**.`
        : 'Not connected. Use `@GitHub signin`.',
      '',
      '📬 **Notifications**',
    ];
    for (const sub of this.subscriptions()) {
      if (
        sub.channel !== message.channel &&
        !(await this.context.buzz.canManage(sub.channel, message.author))
      )
        continue;
      lines.push(
        `- ${await channelLink(this.context, sub.channel)}: ${repoLink(sub.target)}, ${sub.features.map((f) => (f === 'pulls' ? 'pull requests' : f)).join(', ')}.`,
      );
    }
    if (lines.at(-1) === '📬 **Notifications**')
      lines.push('No subscriptions to show.');
    lines.push('', '📊 **Summaries**');
    for (const { key, value: s } of this.context.store.list<Summary>(
      'github:summaries',
    )) {
      if (
        s.author !== message.author &&
        (!s.channel ||
          !(await this.context.buzz.canManage(s.channel, message.author)))
      )
        continue;
      lines.push(
        `- **${s.id}:** ${summarySchedule(s, this.context.config)}. ${s.channel ? await channelLink(this.context, s.channel) : 'Private'}. Scope: ${s.scope === 'personal' ? 'personal contributions' : s.targets.map(repoLink).join(', ')}.${this.context.store.get('github:summary-errors', key) ? ' Delivery needs attention.' : ''}`,
      );
    }
    if (lines.at(-1) === '📊 **Summaries**')
      lines.push('No activity summaries configured.');
    lines.push(
      '',
      'Use `@GitHub summaries` to configure a summary or `@GitHub settings` for notification delivery.',
    );
    return lines.join('\n');
  }
  private async summaries(message: Message, tokens: string[]): Promise<void> {
    const [action, id, ...rest] = tokens;
    if (action === 'help') {
      await this.reply(message, SUMMARY_HELP);
      return;
    }
    if (!action) {
      await this.api.account(message.author);
      await this.form('summaries', message);
      return;
    }
    if (action === 'list') {
      await this.notify(message, await this.status(message));
      return;
    }
    if (action === 'set') {
      if (!id) throw new GithubInputError(SUMMARY_HELP);
      const existing = this.context.store.get<Summary>(
        'github:summaries',
        `${message.author}:${id}`,
      );
      const parsed = rest[0]?.startsWith('{')
        ? { input: JSON.parse(rest.join(' ')) as Summary, missing: [] }
        : summaryInput(id, rest, message, existing);
      if (parsed.missing.length) {
        await this.api.account(message.author);
        await this.form(
          'summaries',
          message,
          { draft: parsed.input },
          `Choose ${parsed.missing.join(', ')} using the configuration link. Your other options are already filled in.`,
        );
        return;
      }
      const input = parsed.input;
      await saveSummary(this.context, this.api, message, { ...input, id });
      await this.reply(
        message,
        `**Summary saved**\n${id}: ${summarySchedule(this.context.store.get<Summary>('github:summaries', `${message.author}:${id}`)!, this.context.config)}.`,
      );
      return;
    }
    const key = `${message.author}:${id ?? action}`;
    const summary = this.context.store.get<Summary>('github:summaries', key);
    if (!summary)
      throw new GithubInputError(
        'That summary does not exist. Use @GitHub summaries to create one.',
      );
    if (
      summary.channel &&
      (summary.channel !== message.channel ||
        !(await this.context.buzz.canManage(summary.channel, message.author)))
    )
      throw new GithubInputError(
        'Manage this summary from its destination channel.',
      );
    if (action === 'enable' || action === 'disable') {
      await saveSummary(this.context, this.api, message, {
        ...summary,
        enabled: action === 'enable',
      });
      await this.reply(
        message,
        `**Summary ${action === 'enable' ? 'enabled' : 'disabled'}**`,
      );
      return;
    }
    if (action === 'delete') {
      this.context.store.delete('github:summaries', key);
      this.context.store.delete('github:summary-errors', key);
      await this.reply(message, '**Summary removed**');
      return;
    }
    if (action === 'preview') {
      await this.notify(
        message,
        (await summaryText(this.api, summary, this.context.config)).body,
      );
      await this.reply(message, 'The summary preview has been sent privately.');
      return;
    }
    if (id)
      throw new GithubInputError(
        'Use summaries, summaries NAME, summaries list, summaries preview NAME or summaries delete NAME.',
      );
    await this.form('summaries', message, { id: action });
  }
  async onWebhook(
    event: string,
    payload: unknown,
    delivery: string,
  ): Promise<void> {
    await deliverWebhook(
      this.context,
      this.api,
      this.subscriptions(),
      event,
      payload,
      delivery,
    );
  }
  async tick(): Promise<void> {
    await deliverReminders(this.context, this.api);
    await deliverSummaries(this.context, this.api);
  }
}
export function createGithubApp(context: AppContext): GithubApp {
  return new GithubApp(context);
}
export function tokenize(input: string): string[] {
  const result: string[] = [];
  let token = '';
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}') depth--;
    if (/\s/.test(character) && depth === 0) {
      if (token) result.push(token);
      token = '';
    } else token += character;
  }
  if (quote || depth !== 0)
    throw new GithubInputError(
      'Close the quote or filter braces in this command.',
    );
  if (token) result.push(token);
  return result;
}
