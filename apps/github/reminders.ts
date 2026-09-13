import { GithubInputError } from './errors.js';
import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { AppContext, Message } from '../../src/core/types.js';
import type { GithubApi } from './api.js';
import { targetParts } from './subscriptions.js';
import { label, link } from './notifications.js';

export interface Reminder {
  id: string;
  author: string;
  channel?: string;
  repos: string[];
  timezone: string;
  days: number[];
  time: string;
  team?: string;
  excludeDrafts?: boolean;
  excludeApproved?: boolean;
  minAgeHours?: number;
  staleHours?: number;
  label?: string;
  title?: string;
  enabled: boolean;
  lastAt?: number;
}
function schedule(reminder: Reminder, currentDate: Date) {
  const [hour, minute] = reminder.time.split(':').map(Number);
  return CronExpressionParser.parse(
    `${minute} ${hour} * * ${reminder.days.join(',')}`,
    { tz: reminder.timezone, currentDate },
  );
}
export async function validateReminder(
  context: AppContext,
  api: GithubApi,
  message: Message,
  input: Reminder,
): Promise<Reminder> {
  if (!/^[a-z\d_-]{1,128}$/i.test(input.id))
    throw new GithubInputError(
      'Reminder ID must contain 1–128 letters, numbers, underscores or hyphens.',
    );
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) ||
    !input.days.length ||
    input.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    throw new GithubInputError(
      'Provide a time as HH:MM and weekdays from 0 (Sunday) to 6 (Saturday).',
    );
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
  } catch {
    throw new GithubInputError('Use a valid timezone such as Europe/London.');
  }
  if (!input.repos.length || input.repos.length > 100)
    throw new GithubInputError('Choose between 1 and 100 repositories.');
  for (const hours of [input.minAgeHours, input.staleHours])
    if (hours !== undefined && (!Number.isFinite(hours) || hours < 0))
      throw new GithubInputError('Age filters must be non-negative hours.');
  if (input.team && !/^[a-z\d-]+\/[a-z\d-]+$/i.test(input.team))
    throw new GithubInputError('Use ORG/TEAM for the review team.');
  if (input.channel) {
    if (
      input.channel !== message.channel ||
      !(await context.buzz.canManage(input.channel, message.author))
    )
      throw new GithubInputError(
        'A channel owner or administrator must configure channel reminders.',
      );
  }
  for (const target of input.repos) {
    if (!targetParts(target).repo)
      throw new GithubInputError(
        'Reminders need repository names, not organisation names.',
      );
    await api.authorised(message.author, target);
  }
  const reminder = { ...input, author: message.author, lastAt: Date.now() };
  schedule(reminder, new Date()).next();
  return reminder;
}
export async function saveReminder(
  context: AppContext,
  api: GithubApi,
  message: Message,
  input: Reminder,
): Promise<void> {
  const reminder = await validateReminder(context, api, message, input);
  context.store.set(
    'github:reminders',
    `${message.author}:${input.id}`,
    reminder,
  );
}
export async function reminderText(
  api: GithubApi,
  reminder: Reminder,
): Promise<string> {
  const account = await api.account(reminder.author);
  const client = await api.user(reminder.author);
  const rows: any[] = [];
  for (const target of reminder.repos) {
    // Each repository is explicitly selected; do not allow free-form search qualifiers.
    const terms = [
      'is:pr',
      'is:open',
      `repo:${target}`,
      reminder.team
        ? `team-review-requested:${reminder.team}`
        : `review-requested:${account.login}`,
    ];
    if (reminder.excludeDrafts !== false) terms.push('draft:false');
    const items: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await client.request('GET /search/issues', {
        q: terms.join(' '),
        per_page: 100,
        sort: 'updated',
        order: 'asc',
        page,
      });
      items.push(...result.data.items);
      if (
        result.data.items.length < 100 ||
        page * 100 >= result.data.total_count
      )
        break;
    }
    for (const item of items) {
      if (
        reminder.minAgeHours &&
        Date.now() - Date.parse(item.created_at) <
          reminder.minAgeHours * 3600000
      )
        continue;
      if (
        reminder.staleHours &&
        Date.now() - Date.parse(item.updated_at) < reminder.staleHours * 3600000
      )
        continue;
      if (
        reminder.label &&
        !item.labels.some(
          (entry: { name?: string } | string | null) =>
            typeof entry === 'object' && entry?.name === reminder.label,
        )
      )
        continue;
      if (
        reminder.title &&
        !item.title.toLowerCase().includes(reminder.title.toLowerCase())
      )
        continue;
      if (reminder.excludeApproved) {
        const { owner, repo } = targetParts(target);
        const reviews = await client.paginate(
          'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
          { owner, repo: repo!, pull_number: item.number, per_page: 100 },
        );
        const latest = new Map<string, string>();
        for (const review of reviews)
          if (review.user?.login && review.state !== 'COMMENTED')
            latest.set(review.user.login, review.state);
        if ([...latest.values()].some((state) => state === 'APPROVED'))
          continue;
      }
      rows.push({ ...item, target });
    }
  }
  if (!rows.length) return 'No pull requests match this review reminder.';
  return `**Review reminder**\n\n${rows
    .slice(0, 40)
    .map(
      (item) =>
        `- [${label(item.target)}#${item.number}: ${label(item.title)}](${link(item.html_url)})`,
    )
    .join(
      '\n',
    )}${rows.length > 40 ? `\n\n${rows.length - 40} more pull requests match.` : ''}`;
}
export async function deliverReminders(
  context: AppContext,
  api: GithubApi,
): Promise<void> {
  const now = Date.now();
  for (const { key, value: reminder } of context.store.list<Reminder>(
    'github:reminders',
  )) {
    if (!reminder.enabled) continue;
    try {
      const previous = reminder.lastAt ?? now;
      const expression = schedule(
        reminder,
        new Date(Math.max(previous, now - 86400000)),
      );
      const due = expression.next().getTime();
      if (due > now) continue;
      const id = createHash('sha256').update(`${key}:${due}`).digest('hex');
      if (!context.store.get('github:reminder-deliveries', id)) {
        if (
          reminder.channel &&
          !(await context.buzz.canManage(reminder.channel, reminder.author))
        )
          throw new GithubInputError(
            'The reminder owner can no longer manage its channel.',
          );
        for (const target of reminder.repos)
          await api.authorised(reminder.author, target);
        const body = await reminderText(api, reminder);
        if (reminder.channel)
          await context.buzz.send(reminder.channel, body, {
            dedupKey: `github:reminder:${id}`,
          });
        else
          await context.buzz.dm(reminder.author, body, {
            dedupKey: `github:reminder:${id}`,
          });
        context.store.set('github:reminder-deliveries', id, true);
      }
      context.store.set('github:reminders', key, { ...reminder, lastAt: now });
    } catch (error) {
      context.log.warn(
        { reminder: key, status: (error as { status?: number }).status },
        'Review reminder failed; it will retry',
      );
    }
  }
}
