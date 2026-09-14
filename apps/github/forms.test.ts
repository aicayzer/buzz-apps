import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.js';
import type {
  AppContext,
  Message,
  Subscription,
} from '../../src/core/types.js';
import { FormInputError, type LinkRecord } from '../../src/core/web.js';
import { createGithubApp } from './index.js';
import { createGithubForms } from './forms.js';
import type { Reminder } from './reminders.js';

let dir: string;
let store: Store;
let ctx: AppContext;
const message: Message = {
  id: 'a'.repeat(64),
  author: 'person',
  channel: 'channel',
  content: '@GitHub settings',
  tags: [['p', 'bot']],
  createdAt: 1,
};
const record = (
  purpose: LinkRecord['purpose'],
  data: Record<string, unknown> = {},
): LinkRecord => ({ purpose, message, data, expires: Date.now() + 60000 });
const sub: Subscription = {
  channel: 'channel',
  target: 'example/repo',
  features: ['issues'],
  settings: {
    threading: false,
    broadcastReviews: true,
    broadcastComments: true,
    previews: false,
  },
  createdBy: 'person',
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buzz-forms-'));
  store = new Store(dir, 'a'.repeat(64));
  ctx = {
    config: {
      relayUrl: 'wss://relay.example',
      identities: { github: { botKey: 'b'.repeat(64) } },
      dataDir: dir,
      publicUrl: 'https://apps.example',
      host: 'localhost',
      port: 12345,
      encryptionKey: 'a'.repeat(64),
      enabledApps: ['github'],
      admins: [],
    },
    store,
    buzz: {
      pubkey: 'bot',
      send: vi.fn(),
      dm: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
      canManage: vi.fn().mockResolvedValue(true),
    },
    link: vi
      .fn()
      .mockImplementation(
        async (_purpose, _message, data) =>
          `https://apps.example/link/${data.target}`,
      ),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function values(
  form: Awaited<ReturnType<ReturnType<typeof createGithubForms>['fields']>>,
): Record<string, string> {
  return Object.fromEntries(
    form.fields.map((field) => [field.name, field.value ?? '']),
  );
}
test('settings hydrate stored toggles and saving an untouched form does not reset them', async () => {
  store.set('subscriptions', 'channel:example/repo', sub);
  const app = createGithubApp(ctx);
  const forms = createGithubForms(ctx, app);
  const form = await forms.fields(record('settings'));
  const posted = values(form);
  expect(posted).toEqual({
    target: 'example/repo',
    threading: 'false',
    broadcastReviews: 'true',
    broadcastComments: 'true',
    previews: 'false',
  });
  expect(
    form.fields.find((field) => field.name === 'threading')?.options,
  ).toEqual([
    { value: 'true', label: 'Yes' },
    { value: 'false', label: 'No' },
  ]);
  await forms.submit(record('settings'), posted);
  expect(
    store.get<Subscription>('subscriptions', 'channel:example/repo')?.settings,
  ).toEqual(sub.settings);
});
test('multiple subscriptions require choosing one before displaying or changing its settings', async () => {
  store.set('subscriptions', 'channel:example/repo', sub);
  store.set('subscriptions', 'channel:example/other', {
    ...sub,
    target: 'example/other',
    settings: { threading: true },
  });
  const forms = createGithubForms(ctx, createGithubApp(ctx));
  const form = await forms.fields(record('settings'));
  expect(form.fields).toEqual([]);
  expect(form.links?.map((link) => link.label)).toEqual([
    'example/other',
    'example/repo',
  ]);
  await expect(
    forms.submit(record('settings'), {
      target: 'example/repo',
      threading: 'true',
      broadcastReviews: 'false',
      broadcastComments: 'false',
      previews: 'true',
    }),
  ).rejects.toBeInstanceOf(FormInputError);
  expect(
    store.get<Subscription>('subscriptions', 'channel:example/repo')?.settings
      .threading,
  ).toBe(false);
});
test('selected settings form cannot be changed to another target by tampering with readonly input', async () => {
  store.set('subscriptions', 'channel:example/repo', sub);
  const forms = createGithubForms(ctx, createGithubApp(ctx));
  const form = await forms.fields(
    record('settings', { target: 'example/repo' }),
  );
  await expect(
    forms.submit(record('settings', { target: 'example/repo' }), {
      ...values(form),
      target: 'example/other',
    }),
  ).rejects.toThrow('Choose a subscription');
});
test('editing a reminder hydrates all fields from the current store rather than a stale link snapshot', async () => {
  const reminder: Reminder = {
    id: 'team-review',
    author: 'person',
    channel: 'channel',
    repos: ['example/repo'],
    timezone: 'Europe/London',
    days: [0, 2, 5],
    time: '15:30',
    team: 'example/reviewers',
    enabled: false,
    excludeDrafts: false,
    excludeApproved: false,
    minAgeHours: 12,
    staleHours: 6,
    label: 'Ready',
    title: 'API',
  };
  store.set('github:reminders', 'person:team-review', reminder);
  const app = createGithubApp(ctx);
  vi.spyOn(app.api, 'authorised').mockResolvedValue({} as any);
  const forms = createGithubForms(ctx, app);
  const link = record('reminders', {
    id: 'team-review',
    reminder: { ...reminder, time: '09:00' },
  });
  const form = await forms.fields(link);
  const posted = values(form);
  expect(posted).toMatchObject({
    id: 'team-review',
    enabled: 'false',
    time: '15:30',
    days: '7,2,5',
    timezone: 'Europe/London',
    destination: 'channel',
    team: 'example/reviewers',
    minimumAgeHours: '12',
    staleHours: '6',
    label: 'Ready',
    titleFilter: 'API',
    excludeDrafts: 'false',
    excludeApproved: 'false',
  });
  await forms.submit(link, posted);
  expect(
    store.get<Reminder>('github:reminders', 'person:team-review'),
  ).toMatchObject(reminder);
});
test('reminder preview validates access and inputs without saving a reminder', async () => {
  const app = createGithubApp(ctx);
  vi.spyOn(app.api, 'authorised').mockResolvedValue({} as any);
  vi.spyOn(app.api, 'account').mockResolvedValue({
    pubkey: 'person',
    login: 'someone',
    token: 'fixture-token',
  });
  vi.spyOn(app.api, 'user').mockResolvedValue({
    request: vi.fn().mockResolvedValue({ data: { items: [] } }),
  } as any);
  const save = vi.spyOn(app, 'configureReminder');
  const forms = createGithubForms(ctx, app);
  const link = record('reminders');
  const input = {
    ...values(await forms.fields(link)),
    repositories: 'example/repo',
    action: 'preview',
  };
  expect(await forms.submit(link, input)).toBe(
    'No pull requests match this review reminder.',
  );
  expect(save).not.toHaveBeenCalled();
  expect(store.list('github:reminders')).toEqual([]);
  await expect(
    forms.submit(link, { ...input, timezone: 'Invalid/Place' }),
  ).rejects.toBeInstanceOf(FormInputError);
  vi.mocked(ctx.buzz.canManage).mockResolvedValue(false);
  await expect(
    forms.submit(link, { ...input, destination: 'channel' }),
  ).rejects.toThrow('administrator');
  expect(store.list('github:reminders')).toEqual([]);
});
test('issue editing loads the real content with the linked account and allows clearing its body', async () => {
  const app = createGithubApp(ctx);
  const request = vi.fn().mockResolvedValue({
    data: { title: 'Current title', body: 'Current description' },
  });
  vi.spyOn(app.api, 'user').mockResolvedValue({ request } as any);
  const edit = vi
    .spyOn(app, 'editIssue')
    .mockResolvedValue('https://github.com/example/repo/issues/1');
  const forms = createGithubForms(ctx, app);
  const link = record('issue-edit', { target: 'example/repo', number: 1 });
  const form = await forms.fields(link);
  expect(values(form)).toEqual({
    target: 'example/repo',
    number: '1',
    title: 'Current title',
    body: 'Current description',
  });
  await forms.submit(link, { ...values(form), body: '' });
  expect(edit).toHaveBeenCalledWith(message, {
    target: 'example/repo',
    number: 1,
    title: 'Current title',
    body: '',
  });
});
test('issue creation from a thread uses the original message and canonical message link', async () => {
  vi.mocked(ctx.buzz.query).mockResolvedValue([
    {
      id: 'thread-root',
      content: 'Original requirement',
      tags: [['h', 'channel']],
    },
  ] as any);
  const forms = createGithubForms(ctx, createGithubApp(ctx));
  const link = {
    ...record('open', { target: 'example/repo' }),
    message: { ...message, root: 'thread-root', content: '@GitHub open' },
  };
  const form = await forms.fields(link);
  expect(values(form).body).toBe(
    'Original requirement\n\nFrom Buzz: buzz://message?channel=channel&id=thread-root',
  );
  expect(ctx.buzz.query).toHaveBeenCalledWith([
    { ids: ['thread-root'], kinds: [9], '#h': ['channel'] },
  ]);
});
test('an unavailable source thread never silently copies a command as the issue description', async () => {
  const forms = createGithubForms(ctx, createGithubApp(ctx));
  await expect(
    forms.fields({
      ...record('open'),
      message: { ...message, root: 'missing' },
    }),
  ).rejects.toThrow('source thread is unavailable');
});

test('partial summary arguments prefill the existing form and submit through authorisation', async () => {
  const app = createGithubApp(ctx);
  vi.spyOn(app.api, 'account').mockResolvedValue({ login: 'person' } as any);
  const forms = createGithubForms(ctx, app);
  const draft = record('summaries', {
    draft: {
      id: 'weekly',
      cadence: 'weekly',
      scope: 'personal',
      targets: [],
      time: '10:30',
      weekday: 1,
      enabled: true,
      skipEmpty: false,
    },
  });
  const fields = await forms.fields(draft);
  expect(values(fields)).toMatchObject({
    id: 'weekly',
    cadence: 'weekly',
    time: '10:30',
    destination: 'personal',
    skipEmpty: 'false',
  });
  expect(fields.fields.find((f) => f.name === 'id')?.readonly).toBe(false);
  const posted = { ...values(fields), destination: 'channel' };
  vi.mocked(ctx.buzz.canManage).mockResolvedValue(false);
  await expect(forms.submit(draft, posted)).rejects.toThrow();
  expect(store.list('github:summaries')).toHaveLength(0);
  vi.mocked(ctx.buzz.canManage).mockResolvedValue(true);
  await forms.submit(draft, posted);
  expect(store.get('github:summaries', 'person:weekly')).toMatchObject({
    channel: 'channel',
    time: '10:30',
  });
});
