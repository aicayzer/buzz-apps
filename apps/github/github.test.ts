import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.js';
import type {
  AppContext,
  Message,
  Subscription,
} from '../../src/core/types.js';
import { createGithubApp, commandText, tokenize } from './index.js';
import { matchesSubscription, parseFeatures } from './subscriptions.js';
import { deliverWebhook, formatNotification } from './notifications.js';
import { deliverReminders, saveReminder } from './reminders.js';
import { previewLinks } from './previews.js';

let dir: string;
let store: Store;
let context: AppContext;
const message: Message = {
  id: 'message-1',
  channel: 'channel',
  author: 'person',
  content: '@GitHub help',
  tags: [['p', 'bot']],
  createdAt: 1,
};
const sub: Subscription = {
  channel: 'channel',
  target: 'example/repo',
  features: ['issues', 'comments', 'commits'],
  settings: {},
  createdBy: 'person',
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buzz-github-'));
  store = new Store(dir, 'a'.repeat(64));
  context = {
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
      send: vi.fn().mockResolvedValue('event-1'),
      dm: vi.fn().mockResolvedValue('dm-1'),
      canManage: vi.fn().mockResolvedValue(true),
      query: vi.fn().mockResolvedValue([]),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test.each(['edited', 'labeled', 'unlabeled', 'synchronize'])(
  'updates the parent without a new reply for %s metadata',
  (action) => {
    const result = formatNotification('pull_request', {
      action,
      repository: { full_name: 'example/repo' },
      sender: { login: 'bot' },
      pull_request: {
        number: 1,
        title: 'Update',
        state: 'open',
        html_url: 'https://github.com/example/repo/pull/1',
        labels: [{ name: 'dependencies' }],
      },
    });
    expect(result?.body).toContain('Labels: dependencies');
    expect(result?.reply).toBeUndefined();
  },
);

describe('command and access boundaries', () => {
  test('help reflects the sender account and keeps notification guidance on separate lines', async () => {
    const app = createGithubApp(context);
    await app.onMessage(message);
    expect(context.buzz.send).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.stringContaining('connect or reconnect'),
      expect.anything(),
    );
    store.saveAccount({ pubkey: 'person', login: 'someone', token: 'token' });
    await app.onMessage({ ...message, id: 'message-2' });
    const text = vi.mocked(context.buzz.send).mock.calls.at(-1)![1];
    expect(text).toContain('Your GitHub account is connected.');
    expect(text).not.toContain('connect or reconnect');
    expect(text).toContain('\n- **Default notifications:**');
    expect(text).toContain('\n- **Optional notifications:**');
  });

  test('requires a real tagged mention, not display text', () => {
    expect(commandText({ ...message, tags: [] }, 'bot')).toBeUndefined();
    expect(commandText(message, 'bot')).toBe('help');
    expect(
      commandText({ ...message, content: '@GitHub (bot) help' }, 'bot'),
    ).toBe('help');
    expect(
      commandText(
        { ...message, content: '[GitHub (bot)](nostr:npub1example) help' },
        'bot',
      ),
    ).toBe('help');
    expect(tokenize('subscribe example/repo +label:"needs review"')).toEqual([
      'subscribe',
      'example/repo',
      '+label:needs review',
    ]);
    expect(tokenize('issue example/repo#1 comment "two words"')).toEqual([
      'issue',
      'example/repo#1',
      'comment',
      'two words',
    ]);
  });
  test('rejects subscriptions before touching GitHub if channel authority is absent', async () => {
    vi.mocked(context.buzz.canManage).mockResolvedValue(false);
    const app = createGithubApp(context);
    const access = vi.spyOn(app.api, 'authorised');
    await app.onMessage({
      ...message,
      content: '@GitHub subscribe example/repo',
    });
    expect(access).not.toHaveBeenCalled();
    expect(store.list('subscriptions')).toHaveLength(0);
    expect(context.buzz.dm).toHaveBeenCalledWith(
      'person',
      expect.stringContaining('administrator'),
      expect.objectContaining({ dedupKey: expect.any(String) }),
    );
  });
  test('subscription is sufficient permission to publish privately, with no extra step', async () => {
    const app = createGithubApp(context);
    vi.spyOn(app.api, 'authorised').mockResolvedValue({} as any);
    await app.onMessage({
      ...message,
      content: '@GitHub subscribe example/repo',
    });
    expect(app.subscriptions()[0].features).toEqual([
      'issues',
      'pulls',
      'commits',
      'releases',
      'deployments',
    ]);
    expect(context.buzz.send).toHaveBeenCalledWith(
      'channel',
      expect.stringContaining('Private repository notifications'),
      expect.anything(),
    );
  });
  test('does not retry an uncertain non-idempotent write', async () => {
    const app = createGithubApp(context);
    const request = vi.fn().mockRejectedValue(new Error('socket closed'));
    vi.spyOn(app.api, 'user').mockResolvedValue({
      request,
      paginate: vi.fn().mockResolvedValue([]),
    } as any);
    await expect(
      app.createIssue(message, { target: 'example/repo', title: 'Title' }),
    ).rejects.toThrow('socket closed');
    await expect(
      app.createIssue(message, { target: 'example/repo', title: 'Title' }),
    ).rejects.toThrow('uncertain');
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('completed writes return original result on replay', async () => {
    const app = createGithubApp(context);
    const request = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/example/repo/issues/1' },
    });
    vi.spyOn(app.api, 'user').mockResolvedValue({ request } as any);
    const input = { target: 'example/repo', title: 'Title' };
    expect(await app.createIssue(message, input)).toBe(
      await app.createIssue(message, input),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
describe('notification filters and state', () => {
  test('default commits exclude other branches, deleted branches and tags', () => {
    const payload = {
      repository: { full_name: 'example/repo', default_branch: 'main' },
      ref: 'refs/heads/main',
    };
    expect(matchesSubscription(sub, 'push', payload)).toBe(true);
    expect(
      matchesSubscription(sub, 'push', { ...payload, ref: 'refs/heads/dev' }),
    ).toBe(false);
    expect(
      matchesSubscription(sub, 'push', { ...payload, ref: 'refs/tags/main' }),
    ).toBe(false);
    expect(
      matchesSubscription(sub, 'push', { ...payload, deleted: true }),
    ).toBe(false);
  });
  test('org targets require exact owner, branch globs and labels apply', () => {
    const subscription = {
      ...sub,
      target: 'example',
      settings: { filters: { branches: ['release/*'], label: 'ready' } },
    };
    expect(
      matchesSubscription(subscription, 'push', {
        repository: { full_name: 'example/repo' },
        ref: 'refs/heads/release/v1',
      }),
    ).toBe(true);
    expect(
      matchesSubscription(subscription, 'push', {
        repository: { full_name: 'example-other/repo' },
        ref: 'refs/heads/release/v1',
      }),
    ).toBe(false);
    expect(
      matchesSubscription(subscription, 'issues', {
        repository: { full_name: 'example/repo' },
        issue: { labels: [{ name: 'other' }] },
      }),
    ).toBe(false);
    expect(
      parseFeatures([
        'workflows',
        'name=CI',
        'branch=main,release/*',
        '+label:ready',
      ]),
    ).toEqual({
      features: ['workflows'],
      filters: {
        workflow: ['CI'],
        branches: ['main', 'release/*'],
        label: 'ready',
      },
    });
  });
  test('workflow default requires PR targeting default branch', () => {
    const subscription = { ...sub, features: ['workflows'] };
    const payload = {
      repository: { full_name: 'example/repo', default_branch: 'main' },
      workflow_run: {
        event: 'pull_request',
        pull_requests: [{ base: { ref: 'main' } }],
      },
    };
    expect(matchesSubscription(subscription, 'workflow_run', payload)).toBe(
      true,
    );
    expect(
      matchesSubscription(subscription, 'workflow_run', {
        ...payload,
        workflow_run: { event: 'push' },
      }),
    ).toBe(false);
  });
  test('webhook redelivery does not duplicate notifications and latest state edits parent', async () => {
    const app = createGithubApp(context);
    const issue = {
      number: 1,
      title: 'A title',
      state: 'open',
      html_url: 'https://github.com/example/repo/issues/1',
      labels: [],
    };
    const request = vi.fn().mockResolvedValue({ data: issue });
    vi.spyOn(app.api, 'installation').mockResolvedValue({ request } as any);
    const payload = {
      repository: {
        full_name: 'example/repo',
        name: 'repo',
        owner: { login: 'example' },
      },
      issue,
      action: 'opened',
      sender: { login: 'author' },
    };
    await deliverWebhook(
      context,
      app.api,
      [sub],
      'issues',
      payload,
      'delivery-1',
    );
    await deliverWebhook(
      context,
      app.api,
      [sub],
      'issues',
      payload,
      'delivery-1',
    );
    expect(context.buzz.send).toHaveBeenCalledTimes(1);
    request.mockResolvedValue({ data: { ...issue, state: 'closed' } });
    await deliverWebhook(
      context,
      app.api,
      [sub],
      'issues',
      { ...payload, action: 'closed' },
      'delivery-2',
    );
    expect(context.buzz.send).toHaveBeenCalledWith(
      'channel',
      expect.stringContaining('), closed'),
      expect.objectContaining({ edit: 'event-1' }),
    );
    expect(context.buzz.send).toHaveBeenCalledWith(
      'channel',
      expect.stringContaining('closed'),
      expect.objectContaining({ root: 'event-1', broadcast: false }),
    );
  });
  test('escapes notification titles and never emits a hostile link', () => {
    const notification = formatNotification('release', {
      repository: { full_name: 'example/repo' },
      release: {
        id: 1,
        name: '[click](evil)',
        html_url: 'javascript:alert(1)',
      },
    });
    expect(notification?.body).toContain('\\[click\\]');
    expect(notification?.url).toBe('https://github.com');
  });
});
describe('private preview and reminders', () => {
  test('unsolicited private preview goes only to sender', async () => {
    const app = createGithubApp(context);
    const request = vi.fn().mockResolvedValue({
      data: {
        private: true,
        full_name: 'example/repo',
        html_url: 'https://github.com/example/repo',
        description: 'Private description',
      },
    });
    vi.spyOn(app.api, 'reader').mockResolvedValue({ request } as any);
    await previewLinks(
      context,
      app.api,
      { ...message, content: 'https://github.com/example/repo' },
      [],
    );
    expect(context.buzz.send).not.toHaveBeenCalled();
    expect(context.buzz.dm).toHaveBeenCalledWith(
      'person',
      expect.stringContaining('Private description'),
      expect.objectContaining({ dedupKey: expect.any(String) }),
    );
  });
  test('approved private subscription permits channel preview', async () => {
    const app = createGithubApp(context);
    const request = vi.fn().mockResolvedValue({
      data: {
        private: true,
        full_name: 'example/repo',
        html_url: 'https://github.com/example/repo',
      },
    });
    vi.spyOn(app.api, 'reader').mockResolvedValue({ request } as any);
    await previewLinks(
      context,
      app.api,
      { ...message, content: 'https://github.com/example/repo' },
      [sub],
    );
    expect(context.buzz.send).toHaveBeenCalledTimes(1);
    expect(context.buzz.dm).not.toHaveBeenCalled();
  });
  test('reminder author cannot be supplied by form and schedule survives restart tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T08:59:00Z'));
    const app = createGithubApp(context);
    vi.spyOn(app.api, 'authorised').mockResolvedValue({} as any);
    vi.spyOn(app.api, 'account').mockResolvedValue({
      pubkey: 'person',
      login: 'someone',
      token: 'test',
    });
    const request = vi.fn().mockResolvedValue({ data: { items: [] } });
    vi.spyOn(app.api, 'user').mockResolvedValue({ request } as any);
    await saveReminder(context, app.api, message, {
      id: 'daily',
      author: 'attacker',
      repos: ['example/repo'],
      timezone: 'UTC',
      days: [1],
      time: '09:00',
      enabled: true,
    });
    expect(store.get<any>('github:reminders', 'person:daily').author).toBe(
      'person',
    );
    vi.setSystemTime(new Date('2026-09-14T09:01:00Z'));
    await deliverReminders(context, app.api);
    await deliverReminders(context, app.api);
    expect(context.buzz.dm).toHaveBeenCalledTimes(1);
  });
});

describe('provider request contracts', () => {
  test('Octokit sends linked-user authorisation and reconciles a lost create response without a second POST', async () => {
    const { Octokit } = await import('octokit');
    const requests: {
      method: string;
      url: string;
      body: string;
      authorisation: string | null;
    }[] = [];
    let created: { body: string; html_url: string } | undefined;
    const fakeFetch = vi.fn(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const request = new Request(input, options);
        const body = await request.text();
        requests.push({
          method: request.method,
          url: request.url,
          body,
          authorisation: request.headers.get('authorization'),
        });
        if (request.method === 'POST') {
          created = {
            body: JSON.parse(body).body,
            html_url: 'https://github.com/example/repo/issues/23',
          };
          throw new Error('Connection lost after GitHub accepted the issue');
        }
        return new Response(JSON.stringify([created]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    const client = new Octokit({
      auth: 'linked-user-token',
      request: { fetch: fakeFetch },
      retry: { enabled: false },
      throttle: { enabled: false },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const app = createGithubApp(context);
    vi.spyOn(app.api, 'user').mockResolvedValue(client);
    const input = {
      target: 'example/repo',
      title: 'An issue',
      body: 'Details',
    };
    await expect(app.createIssue(message, input)).rejects.toThrow();
    expect(await app.createIssue(message, input)).toBe(
      'https://github.com/example/repo/issues/23',
    );
    expect(
      requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
    expect(requests[0].authorisation).toBe('token linked-user-token');
    expect(requests[1].url).toContain('/repos/example/repo/issues?');
    expect(created?.body).toContain('<!-- buzz-apps:');
  });
  test('deployment review resolves an environment by name and uses the user pending-deployments endpoint', async () => {
    const { Octokit } = await import('octokit');
    const seen: { method: string; url: string; body?: any }[] = [];
    const fakeFetch = vi.fn(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const request = new Request(input, options);
        const text = await request.text();
        seen.push({
          method: request.method,
          url: request.url,
          body: text ? JSON.parse(text) : undefined,
        });
        return new Response(
          JSON.stringify(
            request.method === 'GET'
              ? [
                  {
                    environment: { id: 42, name: 'production' },
                    current_user_can_approve: true,
                  },
                ]
              : [],
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );
    const client = new Octokit({
      auth: 'linked-user-token',
      request: { fetch: fakeFetch },
      retry: { enabled: false },
      throttle: { enabled: false },
    });
    const app = createGithubApp(context);
    vi.spyOn(app.api, 'user').mockResolvedValue(client);
    await app.onMessage({
      ...message,
      content: '@GitHub deployment example/repo 123 approve production',
    });
    expect(seen.map((request) => request.method)).toEqual(['GET', 'POST']);
    expect(seen[1].url).toBe(
      'https://api.github.com/repos/example/repo/actions/runs/123/pending_deployments',
    );
    expect(seen[1].body).toEqual({
      environment_ids: [42],
      state: 'approved',
      comment: 'Reviewed through Buzz Apps.',
    });
  });
  test('workflow rerun refuses provider-level automatic retries', async () => {
    const app = createGithubApp(context);
    store.saveAccount({
      pubkey: 'person',
      login: 'someone',
      token: 'linked-user-token',
    });
    const client = await app.api.user('person');
    const request = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('GitHub unavailable'), { status: 503 }),
      );
    client.hook.wrap('request', request);
    vi.spyOn(app.api, 'user').mockResolvedValue(client);
    await app.onMessage({
      ...message,
      content: '@GitHub workflow example/repo 123 rerun failed debug',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('organisation approval and webhook replay', () => {
  test('org subscriptions suppress private repos outside the creator access snapshot', () => {
    const subscription = {
      ...sub,
      target: 'example',
      settings: { approvedRepositories: ['example/allowed'] },
    };
    expect(
      matchesSubscription(subscription, 'issues', {
        repository: { full_name: 'example/allowed', private: true },
        issue: {},
      }),
    ).toBe(true);
    expect(
      matchesSubscription(subscription, 'issues', {
        repository: { full_name: 'example/secret', private: true },
        issue: {},
      }),
    ).toBe(false);
    expect(
      matchesSubscription(subscription, 'issues', {
        repository: { full_name: 'example/public', private: false },
        issue: {},
      }),
    ).toBe(true);
    expect(
      matchesSubscription({ ...subscription, settings: {} }, 'issues', {
        repository: { full_name: 'example/secret', private: true },
        issue: {},
      }),
    ).toBe(false);
  });
  test('an organisation subscription refreshes the private approval snapshot on resubscribe', async () => {
    const app = createGithubApp(context);
    vi.spyOn(app.api, 'authorised').mockResolvedValue({} as any);
    const repositories = vi
      .spyOn(app.api, 'approvedRepositories')
      .mockResolvedValue(['example/one']);
    await app.subscribe(message, ['example']);
    expect(app.subscriptions()[0].settings.approvedRepositories).toEqual([
      'example/one',
    ]);
    repositories.mockResolvedValue(['example/one', 'example/two']);
    await app.subscribe({ ...message, id: 'next-command' }, ['example']);
    expect(app.subscriptions()[0].settings.approvedRepositories).toEqual([
      'example/one',
      'example/two',
    ]);
  });
  test('private previews outside an org snapshot stay private', async () => {
    const app = createGithubApp(context);
    const request = vi.fn().mockResolvedValue({
      data: {
        private: true,
        full_name: 'example/secret',
        html_url: 'https://github.com/example/secret',
      },
    });
    vi.spyOn(app.api, 'reader').mockResolvedValue({ request } as any);
    await previewLinks(
      context,
      app.api,
      { ...message, content: 'https://github.com/example/secret' },
      [
        {
          ...sub,
          target: 'example',
          settings: { approvedRepositories: ['example/allowed'] },
        },
      ],
    );
    expect(context.buzz.send).not.toHaveBeenCalled();
    expect(context.buzz.dm).toHaveBeenCalledTimes(1);
  });
  test('edited and deleted comments update the original reply instead of posting another copy', async () => {
    const app = createGithubApp(context);
    const issue = {
      number: 1,
      title: 'Issue',
      state: 'open',
      html_url: 'https://github.com/example/repo/issues/1',
    };
    vi.spyOn(app.api, 'installation').mockResolvedValue({
      request: vi.fn().mockResolvedValue({ data: issue }),
    } as any);
    const payload = {
      repository: {
        full_name: 'example/repo',
        owner: { login: 'example' },
        name: 'repo',
      },
      issue,
      action: 'created',
      comment: {
        id: 22,
        body: 'First',
        html_url: 'https://github.com/example/repo/issues/1#issuecomment-22',
      },
    };
    await deliverWebhook(
      context,
      app.api,
      [sub],
      'issue_comment',
      payload,
      'one',
    );
    await deliverWebhook(
      context,
      app.api,
      [sub],
      'issue_comment',
      {
        ...payload,
        action: 'edited',
        comment: { ...payload.comment, body: 'Updated' },
      },
      'two',
    );
    expect(context.buzz.send).toHaveBeenCalledWith(
      'channel',
      expect.stringContaining('Updated'),
      expect.objectContaining({ edit: 'event-1' }),
    );
    await deliverWebhook(
      context,
      app.api,
      [sub],
      'issue_comment',
      { ...payload, action: 'deleted' },
      'three',
    );
    expect(context.buzz.send).toHaveBeenCalledWith(
      'channel',
      'Comment deleted on GitHub.',
      expect.objectContaining({ edit: 'event-1' }),
    );
  });
  test('an uninstalled repository cannot release a previously queued webhook', async () => {
    const app = createGithubApp(context);
    vi.spyOn(app.api, 'installation').mockRejectedValue(
      Object.assign(new Error('Not found'), { status: 404 }),
    );
    await expect(
      deliverWebhook(
        context,
        app.api,
        [sub],
        'push',
        {
          repository: {
            full_name: 'example/repo',
            owner: { login: 'example' },
            name: 'repo',
            default_branch: 'main',
          },
          ref: 'refs/heads/main',
          commits: [],
        },
        'one',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(context.buzz.send).not.toHaveBeenCalled();
  });
});

describe('repository transfer publication boundary', () => {
  test.each([
    ['issues/1', 'issue'],
    ['pull/1', 'issue'],
    ['issues/1#issuecomment-22', 'comment'],
    ['pull/1#discussion_r22', 'review-comment'],
    ['pull/1#pullrequestreview-22', 'review'],
  ])(
    'a redirected %s cannot publish private content from another repository',
    async (path, transferred) => {
      const app = createGithubApp(context);
      const request = vi.fn(async (route: string) => {
        if (route === 'GET /repos/{owner}/{repo}')
          return {
            data: {
              full_name: 'example/repo',
              private: true,
              html_url: 'https://github.com/example/repo',
            },
          };
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}')
          return {
            data: {
              number: 1,
              title: 'Issue',
              body:
                transferred === 'issue'
                  ? 'PRIVATE DESTINATION CONTENT'
                  : 'Original issue',
              html_url: `https://github.com/example/${transferred === 'issue' ? 'secret' : 'repo'}/issues/1`,
              repository_url: `https://api.github.com/repos/example/${transferred === 'issue' ? 'secret' : 'repo'}`,
            },
          };
        return {
          data: {
            id: 22,
            body: 'PRIVATE DESTINATION CONTENT',
            html_url:
              'https://github.com/example/secret/issues/1#issuecomment-22',
            url: 'https://api.github.com/repos/example/secret/issues/comments/22',
          },
        };
      });
      vi.spyOn(app.api, 'reader').mockResolvedValue({ request } as any);
      await previewLinks(
        context,
        app.api,
        { ...message, content: `https://github.com/example/repo/${path}` },
        [sub],
      );
      expect(context.buzz.send).not.toHaveBeenCalled();
      expect(context.buzz.dm).not.toHaveBeenCalled();
      expect(store.list('github:previews')).toEqual([]);
    },
  );
  test('an old-repository webhook cannot publish the latest transferred issue', async () => {
    const app = createGithubApp(context);
    const original = {
      number: 1,
      title: 'Original issue',
      state: 'open',
      html_url: 'https://github.com/example/repo/issues/1',
    };
    vi.spyOn(app.api, 'installation').mockResolvedValue({
      request: vi.fn().mockResolvedValue({
        data: {
          ...original,
          title: 'PRIVATE DESTINATION TITLE',
          body: 'Private details',
          html_url: 'https://github.com/example/secret/issues/2',
          repository_url: 'https://api.github.com/repos/example/secret',
        },
      }),
    } as any);
    await deliverWebhook(
      context,
      app.api,
      [sub],
      'issues',
      {
        repository: {
          full_name: 'example/repo',
          name: 'repo',
          owner: { login: 'example' },
        },
        issue: original,
        action: 'transferred',
      },
      'transfer',
    );
    expect(context.buzz.send).not.toHaveBeenCalled();
    expect(store.list('github:objects')).toEqual([]);
  });
  test('conflicting canonical URL fields fail closed even if one still names the subscribed repository', async () => {
    const { belongsToRepository } = await import('./canonical.js');
    expect(
      belongsToRepository('example/repo', {
        html_url: 'https://github.com/example/repo/issues/1',
        repository_url: 'https://api.github.com/repos/example/secret',
      }),
    ).toBe(false);
    expect(
      belongsToRepository('example/repo', {
        html_url: 'https://github.com/Example/Repo/issues/1',
        url: 'https://api.github.com/repos/example/repo/issues/1',
      }),
    ).toBe(true);
    expect(
      belongsToRepository('example/repo', { title: 'No canonical identity' }),
    ).toBe(false);
  });
});

test('stale reminder search results cannot cross a repository transfer boundary', async () => {
  const { reminderText } = await import('./reminders.js');
  const app = createGithubApp(context);
  vi.spyOn(app.api, 'account').mockResolvedValue({
    pubkey: 'person',
    login: 'someone',
    token: 'fixture-token',
  });
  vi.spyOn(app.api, 'user').mockResolvedValue({
    request: vi.fn().mockResolvedValue({
      data: {
        total_count: 1,
        items: [
          {
            number: 2,
            title: 'PRIVATE DESTINATION TITLE',
            html_url: 'https://github.com/example/secret/pull/2',
            repository_url: 'https://api.github.com/repos/example/secret',
            labels: [],
          },
        ],
      },
    }),
  } as any);
  expect(
    await reminderText(app.api, {
      id: 'review',
      author: 'person',
      channel: 'channel',
      repos: ['example/repo'],
      timezone: 'UTC',
      days: [1],
      time: '09:00',
      enabled: true,
    }),
  ).toBe('No pull requests match this review reminder.');
});

test('explicit no-preview metadata prevents even public repository requests', async () => {
  const app = createGithubApp(context);
  const reader = vi.spyOn(app.api, 'reader');
  await previewLinks(
    context,
    app.api,
    {
      ...message,
      content: 'https://github.com/example/repo',
      tags: [['link-preview', 'none']],
    },
    [],
  );
  expect(reader).not.toHaveBeenCalled();
  expect(context.buzz.send).not.toHaveBeenCalled();
});
test('release attribution remains literal and never becomes a Buzz ping', async () => {
  const app = createGithubApp(context);
  store.saveAccount({
    pubkey: 'a'.repeat(64),
    login: 'contributor',
    token: 'fixture',
  });
  await deliverWebhook(
    context,
    app.api,
    [{ ...sub, features: ['releases'] }],
    'release',
    {
      action: 'published',
      repository: { full_name: 'example/repo' },
      release: {
        id: 42,
        name: 'v1',
        body: 'Fix by @contributor in https://github.com/example/repo/pull/1',
        html_url: 'https://github.com/example/repo/releases/tag/v1',
      },
    },
    'release-mention',
  );
  expect(context.buzz.send).toHaveBeenCalledWith(
    'channel',
    expect.stringContaining('by @contributor'),
    expect.objectContaining({ mentions: [] }),
  );
  expect(vi.mocked(context.buzz.send).mock.calls[0][1]).not.toContain(
    'Mentioned:',
  );
});
test('direct comment mentions use Buzz profile names only in the reply', async () => {
  const app = createGithubApp(context);
  const pubkey = 'a'.repeat(64);
  store.saveAccount({ pubkey, login: 'contributor', token: 'fixture' });
  vi.mocked(context.buzz.query).mockResolvedValue([
    {
      pubkey,
      created_at: 10,
      content: JSON.stringify({
        display_name: 'Example Person',
        name: 'example',
      }),
    },
  ] as any);
  await deliverWebhook(
    context,
    app.api,
    [{ ...sub, features: ['comments'] }],
    'issue_comment',
    {
      action: 'created',
      repository: { full_name: 'example/repo' },
      issue: {
        number: 7,
        title: 'Original Title',
        state: 'open',
        html_url: 'https://github.com/example/repo/issues/7',
        assignees: [{ login: 'contributor' }],
      },
      comment: {
        id: 17,
        body: 'Please check this @contributor.',
        html_url: 'https://github.com/example/repo/issues/7#issuecomment-17',
      },
      sender: { login: 'author' },
    },
    'direct-mention',
  );
  const calls = vi.mocked(context.buzz.send).mock.calls;
  expect(calls[0][2]?.mentions).toEqual([]);
  expect(calls[1][1]).toContain('Mentioned: @Example Person');
  expect(calls[1][2]).toMatchObject({ root: 'event-1', mentions: [pubkey] });
  expect(calls[1][1]).not.toContain('nostr:');
});
test('PR presentation has one bold headline and a linked unchanged title', () => {
  const notification = formatNotification('pull_request', {
    action: 'opened',
    repository: { full_name: 'example/repo' },
    pull_request: {
      number: 7,
      title: 'Keep My Title',
      state: 'open',
      html_url: 'https://github.com/example/repo/pull/7',
      user: { login: 'author' },
      base: { ref: 'main' },
      head: { ref: 'feature' },
    },
  });
  expect(notification?.body.match(/\*\*/g)).toHaveLength(2);
  expect(notification?.body).toContain(
    '**PR [Keep My Title](https://github.com/example/repo/pull/7)**',
  );
});

test('lifecycle channel broadcast requires explicit subscription opt-in', async () => {
  const app = createGithubApp(context);
  const subscription = {
    ...sub,
    settings: { ...sub.settings, broadcastUpdates: true },
  };
  const issue = {
    number: 8,
    title: 'Lifecycle',
    state: 'closed',
    html_url: 'https://github.com/example/repo/issues/8',
  };
  store.set('github:objects', 'channel:example/repo:issue:8', {
    id: 'original',
    body: 'Before',
  });
  await deliverWebhook(
    context,
    app.api,
    [subscription],
    'issues',
    {
      repository: { full_name: 'example/repo' },
      issue,
      action: 'closed',
      sender: { login: 'author' },
    },
    'opt-in',
  );
  expect(context.buzz.send).toHaveBeenCalledWith(
    'channel',
    expect.stringContaining('**Issue closed**'),
    expect.objectContaining({ root: 'original', broadcast: true }),
  );
});
