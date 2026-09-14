import { saveSummary, summaryText, type Summary } from './summaries.js';
import { effectiveTimezone, timezoneLabel } from '../../src/core/timezone.js';
import { FormInputError } from '../../src/core/web.js';
import { friendlyError } from './api.js';
import { GithubInputError } from './errors.js';
import type {
  AppContext,
  Message,
  Subscription,
} from '../../src/core/types.js';
import type { FormHandler, LinkRecord } from '../../src/core/web.js';
import type { GithubApp } from './index.js';
import { reminderText, validateReminder, type Reminder } from './reminders.js';
import { subscriptionKey, targetParts } from './subscriptions.js';

type Form = Awaited<ReturnType<FormHandler['fields']>>;
type Field = Form['fields'][number];
const choices = (...values: [string, string][]) =>
  values.map(([value, label]) => ({ value, label }));
const yesNo = choices(['true', 'Yes'], ['false', 'No']);
const booleanField = (name: string, label: string, value: boolean): Field => ({
  name,
  label,
  value: String(value),
  options: yesNo,
  required: true,
});
function booleanValue(values: Record<string, string>, name: string): boolean {
  if (!['true', 'false'].includes(values[name]))
    throw new GithubInputError(`Choose Yes or No for ${name}.`);
  return values[name] === 'true';
}
function existingReminder(
  ctx: AppContext,
  record: LinkRecord,
): Reminder | undefined {
  if (!record.data.id) return;
  const reminder = ctx.store.get<Reminder>(
    'github:reminders',
    `${record.message.author}:${record.data.id}`,
  );
  if (!reminder)
    throw new GithubInputError(
      'This reminder no longer exists. Open a new reminder link from Buzz.',
    );
  if (reminder.channel && reminder.channel !== record.message.channel)
    throw new GithubInputError(
      'Open this reminder from its configured Buzz channel to edit it.',
    );
  return reminder;
}
function selectedSubscription(
  ctx: AppContext,
  message: Message,
  target: string,
): Subscription {
  const subscription = ctx.store.get<Subscription>(
    'subscriptions',
    subscriptionKey(message.channel, target),
  );
  if (!subscription)
    throw new GithubInputError(
      'This channel is not subscribed to that repository or organisation.',
    );
  return subscription;
}
function reminderFromValues(
  record: LinkRecord,
  values: Record<string, string>,
): Reminder {
  if (!['personal', 'channel'].includes(values.destination))
    throw new GithubInputError('Choose a personal or channel destination.');
  if (!['save', 'preview'].includes(values.action))
    throw new GithubInputError('Choose Save or Preview.');
  const days = (values.days ?? '')
    .split(',')
    .map((value) => Number(value.trim()));
  if (days.some((day) => !Number.isInteger(day) || day < 1 || day > 7))
    throw new GithubInputError(
      'Weekdays must be numbers from 1 (Monday) to 7 (Sunday).',
    );
  if (record.data.id && record.data.id !== values.id)
    throw new GithubInputError('The reminder ID cannot change while editing.');
  return {
    id: values.id,
    author: record.message.author,
    channel:
      values.destination === 'channel' ? record.message.channel : undefined,
    repos: (values.repositories ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    timezone: values.timezone,
    time: values.time,
    days: days.map((day) => day % 7),
    team: values.team?.trim() || undefined,
    minAgeHours: Number(values.minimumAgeHours || 0),
    staleHours: Number(values.staleHours || 0),
    label: values.label?.trim() || undefined,
    title: values.titleFilter?.trim() || undefined,
    excludeDrafts: booleanValue(values, 'excludeDrafts'),
    excludeApproved: booleanValue(values, 'excludeApproved'),
    enabled: booleanValue(values, 'enabled'),
  };
}

export function createGithubForms(
  ctx: AppContext,
  github: GithubApp,
): FormHandler {
  const handler: FormHandler = {
    async fields(record): Promise<Form> {
      const { message, data } = record;
      if (record.purpose === 'summaries') {
        const saved = data.id
          ? ctx.store.get<Summary>(
              'github:summaries',
              `${message.author}:${data.id}`,
            )
          : (data.draft as Summary | undefined);
        if (data.id && !saved)
          throw new GithubInputError('This summary no longer exists.');
        if (
          saved?.channel &&
          (saved.channel !== message.channel ||
            !(await ctx.buzz.canManage(saved.channel, message.author)))
        )
          throw new GithubInputError(
            'Open this summary from its destination channel.',
          );
        return {
          title: data.id ? 'Edit activity summary' : 'Create activity summary',
          fields: [
            {
              name: 'id',
              label: 'Name',
              value: saved?.id ?? '',
              required: true,
              readonly: !!data.id,
            },
            {
              name: 'cadence',
              label: 'Frequency',
              value: saved?.cadence ?? 'daily',
              required: true,
              options: choices(['daily', 'Daily'], ['weekly', 'Weekly']),
            },
            {
              name: 'enabled',
              label: 'Status',
              value: String(saved?.enabled ?? true),
              required: true,
              options: choices(['true', 'Enabled'], ['false', 'Disabled']),
            },
            {
              name: 'scope',
              label: 'Scope',
              value: saved?.scope ?? 'personal',
              required: true,
              options: choices(
                ['personal', 'My contributions'],
                ['repositories', 'Repositories'],
                ['organisation', 'Organisation'],
              ),
            },
            {
              name: 'targets',
              label:
                'Repositories (comma separated) or organisation, blank for personal',
              value: saved?.targets.join(', ') ?? '',
            },
            {
              name: 'destination',
              label: 'Send to',
              value: saved?.channel ? 'channel' : 'personal',
              options: choices(
                ['personal', 'Me privately'],
                ['channel', 'This channel, including private activity'],
              ),
              required: true,
            },
            {
              name: 'time',
              label: `Time (${timezoneLabel(effectiveTimezone(ctx.config, saved?.timezone))})`,
              type: 'time',
              value: saved?.time ?? '09:00',
              required: true,
            },
            {
              name: 'weekday',
              label: 'Day for weekly summaries',
              value: String(saved?.weekday ?? 1),
              options: [
                'Sunday',
                'Monday',
                'Tuesday',
                'Wednesday',
                'Thursday',
                'Friday',
                'Saturday',
              ].map((label, value) => ({ label, value: String(value) })),
              required: true,
            },
            {
              name: 'timezone',
              label: 'Timezone override (blank uses the service default)',
              value: saved?.timezone ?? '',
            },
            booleanField(
              'skipEmpty',
              'Skip empty periods',
              saved?.skipEmpty ?? true,
            ),
            {
              name: 'action',
              label: 'Action',
              value: 'save',
              options: choices(
                ['save', 'Save summary'],
                ['preview', 'Preview summary'],
              ),
              required: true,
            },
          ],
        };
      }
      if (record.purpose === 'settings') {
        await github.manage(message);
        const subscriptions = github.subscriptions(message.channel);
        if (!subscriptions.length)
          throw new GithubInputError(
            'Subscribe this channel to a repository before opening its settings.',
          );
        if (!data.target && subscriptions.length > 1) {
          if (!ctx.link)
            throw new GithubInputError('Browser links are unavailable.');
          return {
            title: 'Choose a subscription',
            fields: [],
            links: await Promise.all(
              subscriptions.map(async (sub) => ({
                label: sub.target,
                url: await ctx.link!('settings', message, {
                  target: sub.target,
                }),
              })),
            ),
          };
        }
        const target = String(data.target ?? subscriptions[0].target);
        const subscription = selectedSubscription(ctx, message, target);
        return {
          title: `Settings for ${subscription.target}`,
          fields: [
            {
              name: 'target',
              label: 'Repository or organisation',
              value: subscription.target,
              readonly: true,
              required: true,
            },
            booleanField(
              'threading',
              'Thread related updates',
              subscription.settings.threading !== false,
            ),
            booleanField(
              'broadcastUpdates',
              'Show closed, reopened and ready updates in the channel as well as their thread',
              subscription.settings.broadcastUpdates === true,
            ),
            booleanField(
              'broadcastReviews',
              'Show reviews in the channel as well as their thread',
              subscription.settings.broadcastReviews === true,
            ),
            booleanField(
              'broadcastComments',
              'Show comments in the channel as well as their thread',
              subscription.settings.broadcastComments === true,
            ),
            booleanField(
              'previews',
              'Show GitHub link previews',
              subscription.settings.previews !== false,
            ),
          ],
        };
      }
      if (record.purpose === 'open') {
        let source = '';
        const sourceId = message.root;
        if (sourceId) {
          const events = await ctx.buzz.query([
            { ids: [sourceId], kinds: [9], '#h': [message.channel] },
          ]);
          const event = events.find(
            (item) =>
              item.id === sourceId &&
              item.tags.some(
                (tag) => tag[0] === 'h' && tag[1] === message.channel,
              ),
          );
          if (!event)
            throw new GithubInputError(
              'The source thread is unavailable. Open a new issue from a message you can access.',
            );
          source = `${event.content}\n\nFrom Buzz: buzz://message?channel=${encodeURIComponent(message.channel)}&id=${encodeURIComponent(sourceId)}`;
        }
        return {
          title: 'Create GitHub issue',
          fields: [
            {
              name: 'target',
              label: 'Repository (owner/repo)',
              value: String(data.target ?? ''),
              required: true,
            },
            { name: 'title', label: 'Title', required: true },
            {
              name: 'body',
              label: 'Description',
              value: source,
              type: 'textarea',
            },
          ],
        };
      }
      if (record.purpose === 'issue-edit') {
        const target = String(data.target ?? '');
        const number = Number(data.number);
        const { owner, repo } = targetParts(target);
        if (!repo || !Number.isSafeInteger(number) || number < 1)
          throw new GithubInputError(
            'The issue link is invalid. Open a new edit link from Buzz.',
          );
        const client = await github.api.user(message.author);
        const issue = (
          await client.request(
            'GET /repos/{owner}/{repo}/issues/{issue_number}',
            { owner, repo, issue_number: number },
          )
        ).data;
        return {
          title: `Edit issue #${number}`,
          fields: [
            {
              name: 'target',
              label: 'Repository',
              value: target,
              readonly: true,
              required: true,
            },
            {
              name: 'number',
              label: 'Issue number',
              value: String(number),
              readonly: true,
              required: true,
            },
            {
              name: 'title',
              label: 'Title',
              value: issue.title,
              required: true,
            },
            {
              name: 'body',
              label: 'Description',
              value: issue.body ?? '',
              type: 'textarea',
            },
          ],
        };
      }
      if (record.purpose !== 'reminders')
        throw new GithubInputError('This link does not open an editable form.');
      const reminder = existingReminder(ctx, record);
      return {
        title: reminder ? 'Edit review reminder' : 'Create review reminder',
        fields: [
          {
            name: 'id',
            label: 'Reminder name',
            value: reminder?.id ?? message.id,
            readonly: !!reminder,
            required: true,
          },
          booleanField('enabled', 'Enabled', reminder?.enabled ?? true),
          {
            name: 'action',
            label: 'Action',
            value: 'save',
            options: choices(
              ['save', 'Save reminder'],
              ['preview', 'Preview matching pull requests'],
            ),
            required: true,
          },
          {
            name: 'repositories',
            label: 'Repositories (comma separated owner/repo)',
            value: reminder?.repos.join(', ') ?? '',
            required: true,
          },
          {
            name: 'timezone',
            label: 'Timezone override (leave blank for service default)',
            value: reminder?.timezone ?? '',
          },
          {
            name: 'time',
            label: 'Time',
            type: 'time',
            value: reminder?.time ?? '09:00',
            required: true,
          },
          {
            name: 'days',
            label: 'Weekdays (1 = Monday, 7 = Sunday)',
            value:
              reminder?.days.map((day) => day || 7).join(',') ?? '1,2,3,4,5',
            required: true,
          },
          {
            name: 'team',
            label: 'Review team (optional organisation/team)',
            value: reminder?.team ?? '',
          },
          {
            name: 'destination',
            label: 'Send to',
            value: reminder?.channel ? 'channel' : 'personal',
            options: choices(
              ['personal', 'Me privately'],
              ['channel', 'This Buzz channel'],
            ),
            required: true,
          },
          {
            name: 'minimumAgeHours',
            label: 'Minimum pull request age (hours)',
            type: 'number',
            value: String(reminder?.minAgeHours ?? 0),
          },
          {
            name: 'staleHours',
            label: 'Minimum time since last update (hours)',
            type: 'number',
            value: String(reminder?.staleHours ?? 0),
          },
          {
            name: 'label',
            label: 'Required label (optional)',
            value: reminder?.label ?? '',
          },
          {
            name: 'titleFilter',
            label: 'Title contains (optional)',
            value: reminder?.title ?? '',
          },
          booleanField(
            'excludeDrafts',
            'Exclude drafts',
            reminder?.excludeDrafts ?? true,
          ),
          booleanField(
            'excludeApproved',
            'Exclude approved pull requests',
            reminder?.excludeApproved ?? true,
          ),
        ],
      };
    },
    async submit(record, values) {
      const message = record.message;
      if (record.purpose === 'summaries') {
        if (record.data.id && record.data.id !== values.id)
          throw new GithubInputError(
            'The summary name cannot change while editing.',
          );
        if (
          !['personal', 'channel'].includes(values.destination) ||
          !['save', 'preview'].includes(values.action)
        )
          throw new GithubInputError('Choose a destination and action.');
        const input = {
          id: values.id,
          author: message.author,
          cadence: values.cadence,
          scope: values.scope,
          targets: values.targets
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          channel:
            values.destination === 'channel' ? message.channel : undefined,
          time: values.time,
          weekday: Number(values.weekday),
          timezone: values.timezone,
          enabled: booleanValue(values, 'enabled'),
          skipEmpty: booleanValue(values, 'skipEmpty'),
          lastAt: Date.now(),
        } as Summary;
        if (values.action === 'preview') {
          const { validateSummary } = await import('./summaries.js');
          return (
            await summaryText(
              github.api,
              await validateSummary(ctx, github.api, message, input),
              ctx.config,
            )
          ).body;
        }
        await saveSummary(ctx, github.api, message, input);
        return 'Activity summary saved.';
      }

      if (record.purpose === 'open')
        return `Issue created: ${await github.createIssue(message, { target: values.target, title: values.title, body: values.body })}`;
      if (record.purpose === 'issue-edit') {
        if (
          values.target !== record.data.target ||
          Number(values.number) !== record.data.number
        )
          throw new GithubInputError(
            'The issue target cannot change while editing.',
          );
        if (!values.title?.trim())
          throw new GithubInputError('The issue needs a title.');
        return `Issue updated: ${await github.editIssue(message, { target: values.target, number: Number(values.number), title: values.title, body: values.body ?? '' })}`;
      }
      if (record.purpose === 'settings') {
        const subscriptions = github.subscriptions(message.channel);
        const target = String(
          record.data.target ??
            (subscriptions.length === 1 ? subscriptions[0].target : ''),
        );
        if (!target || values.target !== target)
          throw new GithubInputError(
            'Choose a subscription before changing its settings.',
          );
        await github.updateSettings(message, target, {
          threading: booleanValue(values, 'threading'),
          broadcastUpdates: booleanValue(values, 'broadcastUpdates'),
          broadcastReviews: booleanValue(values, 'broadcastReviews'),
          broadcastComments: booleanValue(values, 'broadcastComments'),
          previews: booleanValue(values, 'previews'),
        });
        return 'Channel settings saved.';
      }
      if (record.purpose !== 'reminders')
        throw new GithubInputError('This link does not accept form changes.');
      if (record.data.id) existingReminder(ctx, record);
      const reminder = reminderFromValues(record, values);
      if (values.action === 'preview')
        return await reminderText(
          github.api,
          await validateReminder(ctx, github.api, message, reminder),
        );
      await github.configureReminder(message, reminder);
      return 'Review reminder saved.';
    },
  };
  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof GithubInputError ||
        (error as { status?: number }).status
      )
        throw new FormInputError(friendlyError(error));
      throw error;
    }
  }
  return {
    isPreview: (record, values) =>
      ['reminders', 'summaries'].includes(record.purpose) &&
      values.action === 'preview',
    fields: (record) => safely(() => handler.fields(record)),
    submit: (record, values) => safely(() => handler.submit(record, values)),
  };
}
