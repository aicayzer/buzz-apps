import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.js';
import { completedPeriod, effectiveTimezone } from '../../src/core/timezone.js';
import {
  deliverSummaries,
  dueAt,
  saveSummary,
  summaryText,
  validateSummary,
  type Summary,
} from './summaries.js';
import { createGithubApp } from './index.js';
import type { AppContext, Message } from '../../src/core/types.js';
import type { GithubApi } from './api.js';
let ctx: AppContext, api: GithubApi, store: Store, dir: string;
const message = {
  id: 'message',
  author: 'person',
  channel: 'room',
  content: '',
  tags: [],
  createdAt: 0,
} as Message;
const base: Summary = {
  id: 'daily',
  author: 'person',
  cadence: 'daily',
  scope: 'personal',
  targets: [],
  channel: 'room',
  time: '00:01',
  weekday: 1,
  enabled: true,
  skipEmpty: false,
  lastAt: 0,
};
const now = Date.parse('2026-09-14T00:02:00Z');
const collection = {
  totalCommitContributions: 2,
  totalIssueContributions: 0,
  totalPullRequestContributions: 1,
  totalPullRequestReviewContributions: 0,
  contributionCalendar: { totalContributions: 3 },
  commitContributionsByRepository: [
    {
      repository: { nameWithOwner: 'example/repo' },
      contributions: { totalCount: 2 },
    },
  ],
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buzz-summary-'));
  store = new Store(dir, 'a'.repeat(64));
  ctx = {
    config: { timezone: 'Europe/London' },
    store,
    buzz: {
      pubkey: 'bot',
      canManage: vi.fn().mockResolvedValue(true),
      channelName: vi.fn().mockResolvedValue('development'),
      send: vi.fn().mockResolvedValue('event'),
      dm: vi.fn().mockResolvedValue('private'),
      query: vi.fn().mockResolvedValue([]),
    },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as AppContext;
  api = {
    account: vi.fn().mockResolvedValue({ login: 'person' }),
    user: vi.fn().mockResolvedValue({
      graphql: vi.fn().mockResolvedValue({
        viewer: {
          login: 'person',
          current: collection,
          previous: collection,
        },
      }),
    }),
    authorised: vi.fn().mockResolvedValue({}),
    approvedRepositories: vi.fn().mockResolvedValue(['example/repo']),
  } as unknown as GithubApi;
  api.contributions = api.user;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
test.each([
  ['2026-03-30T00:01:00Z', 23],
  ['2026-10-26T00:01:00Z', 25],
])('local days span DST correctly: %s', (at, hours) => {
  const p = completedPeriod(new Date(at), 'Europe/London', 1);
  expect((p.to.getTime() - p.from.getTime()) / 3600000).toBe(hours);
});
test('timezone inherits explicitly and accepts an override', () => {
  expect(effectiveTimezone(ctx.config)).toBe('Europe/London');
  expect(effectiveTimezone(ctx.config, 'America/Los_Angeles')).toBe(
    'America/Los_Angeles',
  );
  expect(() => effectiveTimezone(ctx.config, 'Mars/Olympus')).toThrow();
});
test('daily and weekly due times use their own timezone', () => {
  expect(
    dueAt({ ...base, lastAt: now - 60000 }, ctx.config, now),
  ).toBeUndefined();
  expect(
    dueAt({ ...base, timezone: 'UTC', lastAt: now - 120000 }, ctx.config, now),
  ).toBe(Date.parse('2026-09-14T00:01:00Z'));
  expect(dueAt({ ...base, enabled: false }, ctx.config, now)).toBeUndefined();
});
test('save binds author and rejects another destination', async () => {
  await saveSummary(ctx, api, message, { ...base, author: 'impostor' });
  expect(store.get<Summary>('github:summaries', 'person:daily')?.author).toBe(
    'person',
  );
  await expect(
    validateSummary(ctx, api, message, { ...base, channel: 'other' }),
  ).rejects.toThrow('destination');
});
test('channel summaries require management authority', async () => {
  vi.mocked(ctx.buzz.canManage).mockResolvedValue(false);
  await expect(saveSummary(ctx, api, message, base)).rejects.toThrow();
});
test('organisation approval freezes the repository set', async () => {
  const s = await validateSummary(ctx, api, message, {
    ...base,
    scope: 'organisation',
    targets: ['example'],
  });
  expect(s.approvedRepositories).toEqual(['example/repo']);
  vi.mocked(api.approvedRepositories).mockResolvedValue([]);
  await expect(summaryText(api, s, ctx.config, new Date(now))).rejects.toThrow(
    'access changed',
  );
});
test('personal summaries reject misleading repository filters', async () => {
  await expect(
    validateSummary(ctx, api, message, { ...base, targets: ['example/repo'] }),
  ).rejects.toThrow('Personal');
});
test('personal data uses the completed local day and links repositories', async () => {
  const result = await summaryText(api, base, ctx.config, new Date(now));
  expect(result.body).toContain('13 September');
  expect(result.body).toContain(
    '[example/repo](https://github.com/example/repo)',
  );
  const client = await api.user('person');
  expect(client.graphql).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      from: '2026-09-13T00:00:00+01:00',
      to: '2026-09-13T23:59:59+01:00',
    }),
  );
});
test('daily and weekly remain separate and do not redeliver', async () => {
  store.set('github:summaries', 'person:daily', base);
  store.set('github:summaries', 'person:weekly', {
    ...base,
    id: 'weekly',
    cadence: 'weekly',
  });
  await deliverSummaries(ctx, api, now);
  await deliverSummaries(ctx, api, now + 1000);
  expect(ctx.buzz.send).toHaveBeenCalledTimes(2);
  const calls = vi.mocked(ctx.buzz.send).mock.calls;
  expect(calls[0][2]?.dedupKey).not.toBe(calls[1][2]?.dedupKey);
  expect(calls.map((c) => c[1]).join('')).toContain('Weekly GitHub summary');
});
test('uncertain delivery retries the same period and deduplication key', async () => {
  store.set('github:summaries', 'person:daily', base);
  vi.mocked(ctx.buzz.send).mockRejectedValueOnce(new Error('ACK lost'));
  await deliverSummaries(ctx, api, now);
  expect(store.get('github:summary-errors', 'person:daily')).toBeDefined();
  await deliverSummaries(ctx, api, now + 86400000);
  const calls = vi.mocked(ctx.buzz.send).mock.calls;
  expect(calls[0][2]?.dedupKey).toBe(calls[1][2]?.dedupKey);
  expect(calls[0][1]).toBe(calls[1][1]);
  expect(store.get('github:summary-errors', 'person:daily')).toBeUndefined();
});
test('revoked management blocks scheduled disclosure', async () => {
  store.set('github:summaries', 'person:daily', base);
  vi.mocked(ctx.buzz.canManage).mockResolvedValue(false);
  await deliverSummaries(ctx, api, now);
  expect(ctx.buzz.send).not.toHaveBeenCalled();
  expect(store.get('github:summary-errors', 'person:daily')).toBeDefined();
});
test('empty summaries can be skipped', async () => {
  const client = await api.user('person');
  vi.mocked(client.graphql).mockResolvedValue({
    viewer: {
      login: 'person',
      current: {
        ...collection,
        contributionCalendar: { totalContributions: 0 },
      },
      previous: collection,
    },
  });
  store.set('github:summaries', 'person:daily', { ...base, skipEmpty: true });
  await deliverSummaries(ctx, api, now);
  expect(ctx.buzz.send).not.toHaveBeenCalled();
  expect(store.get<Summary>('github:summaries', 'person:daily')?.lastAt).toBe(
    now,
  );
});
test('overview does not disclose another channel or personal summary', async () => {
  store.set('subscriptions', 'other', {
    target: 'secret/repo',
    channel: 'other',
    features: ['issues'],
    settings: {},
    createdBy: 'else',
  });
  store.set('github:summaries', 'else:private', {
    ...base,
    author: 'else',
    channel: undefined,
    id: 'private',
  });
  vi.mocked(ctx.buzz.canManage).mockResolvedValue(false);
  const body = await createGithubApp(ctx).status(message);
  expect(body).not.toContain('secret/repo');
  expect(body).not.toContain('**private:');
});

test('readiness failure clears when a summary is disabled', async () => {
  store.set('github:summary-errors', 'person:daily', { nextAt: now + 60000 });
  await saveSummary(ctx, api, message, { ...base, enabled: false });
  expect(store.get('github:summary-errors', 'person:daily')).toBeUndefined();
});
test('contribution credentials cannot impersonate another linked account', async () => {
  store.saveAccount({
    pubkey: 'person',
    login: 'alice',
    token: 'ordinary-token',
  });
  ctx.config.githubContributionTokens = { person: 'summary-token' };
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ login: 'bob' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(
      createGithubApp(ctx).api.contributions('person'),
    ).rejects.toThrow('different GitHub account');
  } finally {
    vi.unstubAllGlobals();
  }
});
test('retry backoff avoids hammering an unavailable provider', async () => {
  store.set('github:summaries', 'person:daily', base);
  vi.mocked(ctx.buzz.send).mockRejectedValue(new Error('offline'));
  await deliverSummaries(ctx, api, now);
  await deliverSummaries(ctx, api, now + 1000);
  expect(ctx.buzz.send).toHaveBeenCalledTimes(1);
});

test('readable arguments save through the same account and channel checks', async () => {
  const app = createGithubApp(ctx);
  vi.spyOn(app.api, 'account').mockResolvedValue({ login: 'person' } as any);
  const command = {
    ...message,
    tags: [['p', 'bot']],
    content:
      'summaries set readable --cadence daily --scope personal --time 09:00 --destination here',
  };
  await app.onMessage(command);
  expect(
    store.get<Summary>('github:summaries', 'person:readable')?.channel,
  ).toBe('room');
  vi.mocked(ctx.buzz.canManage).mockResolvedValue(false);
  await app.onMessage({
    ...command,
    content: command.content.replace('readable', 'denied'),
  });
  expect(store.get('github:summaries', 'person:denied')).toBeUndefined();
});
test('partial command opens a prefilled form without saving or assuming a destination', async () => {
  const app = createGithubApp(ctx);
  vi.spyOn(app.api, 'account').mockResolvedValue({ login: 'person' } as any);
  ctx.link = vi.fn().mockResolvedValue('https://example.com/private');
  await app.onMessage({
    ...message,
    tags: [['p', 'bot']],
    content:
      'summaries set weekly --cadence weekly --scope personal --time 10:30',
  });
  expect(ctx.link).toHaveBeenCalledWith('summaries', expect.anything(), {
    draft: expect.objectContaining({
      id: 'weekly',
      time: '10:30',
      cadence: 'weekly',
    }),
  });
  expect(store.list('github:summaries')).toHaveLength(0);
  expect(ctx.buzz.send).toHaveBeenCalledWith(
    'room',
    expect.stringContaining('destination'),
    expect.anything(),
  );
});
test('enable and disable cannot edit another destination channel', async () => {
  store.set('github:summaries', 'person:daily', base);
  const app = createGithubApp(ctx);
  await app.onMessage({
    ...message,
    channel: 'different',
    tags: [['p', 'bot']],
    content: 'summaries disable daily',
  });
  expect(store.get<Summary>('github:summaries', 'person:daily')?.enabled).toBe(
    true,
  );
});
