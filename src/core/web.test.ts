import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebFlows, escapeHtml, FormInputError } from './web.js';
import { Store } from './store.js';
import type { AppContext, Message } from './types.js';
const cleanups: (() => Promise<void>)[] = [];
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'buzz-web-test-'));
  const store = new Store(dir, '11'.repeat(32));
  const ctx = {
    config: {
      publicUrl: 'https://apps.example.com',
      github: { clientId: 'test' },
    },
    store,
    buzz: { dm: vi.fn() },
    log: {},
  } as unknown as AppContext;
  const server = Fastify();
  server.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_r, b, d) => d(null, Object.fromEntries(new URLSearchParams(b as string))),
  );
  const web = new WebFlows(ctx);
  web.routes(server);
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const message = {
    id: 'event',
    author: 'person',
    channel: 'room',
    content: 'hello',
    tags: [],
    createdAt: 0,
  } satisfies Message;
  return { store, server, web, message, ctx, dir };
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
  vi.unstubAllGlobals();
});
describe('private browser flows', () => {
  it('keeps a preview session, allows safe input corrections, and consumes uncertain writes', async () => {
    const f = await fixture(),
      token = 'preview-session';
    const key = createHash('sha256').update(token).digest('hex');
    f.store.set('web:sessions', key, {
      purpose: 'reminders',
      message: f.message,
      data: {},
      expires: Date.now() + 60000,
    });
    f.store.set('web:csrf', key, 'csrf-token');
    f.web.forms = {
      fields: async () => ({ title: 'Reminder', fields: [] }),
      isPreview: (_r, values) => values.action === 'preview',
      submit: async (_r, values) => {
        if (values.action === 'invalid')
          throw new FormInputError('Choose at least one day.');
        if (values.action === 'uncertain')
          throw new Error('Provider operation failed.');
        return 'Preview only';
      },
    };
    const submit = (action: string) =>
      f.server.inject({
        method: 'POST',
        url: '/github/form',
        headers: {
          cookie: `buzz_session=${token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `csrf=csrf-token&action=${action}`,
      });
    expect((await submit('preview')).body).toContain('Back to settings');
    expect(f.store.get('web:sessions', key)).toBeDefined();
    expect((await submit('invalid')).statusCode).toBe(400);
    expect(f.store.get('web:sessions', key)).toBeDefined();
    expect((await submit('uncertain')).statusCode).toBe(500);
    expect(f.store.get('web:sessions', key)).toBeUndefined();
  });

  it('keeps failed credential persistence encrypted and retries without another GitHub conversion', async () => {
    const f = await fixture();
    const writer = join(f.dir, 'retry-writer');
    writeFileSync(
      writer,
      `#!${process.execPath}\nprocess.stderr.write('provider-secret-output');process.exit(1);\n`,
      { mode: 0o700 },
    );
    f.ctx.config.github = undefined;
    f.ctx.config.setupToken = 'setup-capability';
    f.ctx.config.githubCredentialsWriter = writer;
    const setup = await f.server.inject('/setup/github?token=setup-capability');
    const state = /settings\/apps\/new\?state=([^"&]+)/.exec(setup.body)![1];
    const convert = vi.fn(async () =>
      Response.json({
        id: 321,
        pem: 'staged-private-key',
        client_id: 'client',
        client_secret: 'staged-client-secret',
        webhook_secret: 'staged-webhook-secret',
        slug: 'staged-app',
      }),
    );
    vi.stubGlobal('fetch', convert);
    const failed = await f.server.inject(
      `/setup/github/callback?state=${state}&code=code`,
    );
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('provider-secret-output');
    expect(f.ctx.config.github).toBeUndefined();
    expect(
      f.store.get<string>('github:setup-secrets', 'pending'),
    ).not.toContain('staged-private-key');
    expect(
      f.store.secret<{ github: { privateKey: string } }>(
        'github:setup-secrets',
        'pending',
      )?.github.privateKey,
    ).toBe('staged-private-key');
    const recovery = await f.server.inject(
      '/setup/github?token=setup-capability',
    );
    expect(recovery.body).toContain('Save registration');
    expect(recovery.body).not.toContain('settings/apps/new');
    writeFileSync(writer, `#!${process.execPath}\nprocess.stdin.resume();\n`, {
      mode: 0o700,
    });
    const result = await f.server.inject({
      method: 'POST',
      url: '/setup/github/save',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=setup-capability',
    });
    expect(result.statusCode).toBe(200);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(f.store.get('github:setup-secrets', 'pending')).toBeUndefined();
    expect(f.ctx.config.github?.appId).toBe('321');
  });
  it('purges expired browser capabilities and orphaned CSRF records while preserving active sessions', async () => {
    const f = await fixture();
    for (const space of ['web:links', 'web:oauth', 'web:sessions', 'web:setup'])
      f.store.set(space, 'expired', { expires: Date.now() - 1 });
    f.store.set('web:sessions', 'active', { expires: Date.now() + 60000 });
    f.store.set('web:csrf', 'expired', 'secret');
    f.store.set('web:csrf', 'active', 'secret');
    f.web.purgeExpired();
    for (const space of ['web:links', 'web:oauth', 'web:setup'])
      expect(f.store.list(space)).toHaveLength(0);
    expect(f.store.list('web:sessions')).toHaveLength(1);
    expect(f.store.list('web:csrf').map((row) => row.key)).toEqual(['active']);
  });
  it('renders current select values and displays only deliberately safe validation errors', async () => {
    const f = await fixture();
    const session = 'private-session';
    const key = createHash('sha256').update(session).digest('hex');
    f.store.set('web:sessions', key, {
      purpose: 'settings',
      message: f.message,
      data: {},
      expires: Date.now() + 60000,
    });
    f.web.forms = {
      fields: async () => ({
        title: 'Settings',
        fields: [
          {
            name: 'enabled',
            label: 'Enabled',
            value: 'false',
            options: [
              { value: 'true', label: 'Yes' },
              { value: 'false', label: 'No' },
            ],
          },
        ],
      }),
      submit: async () => '',
    };
    let result = await f.server.inject({
      url: '/github/form',
      headers: { cookie: `buzz_session=${session}` },
    });
    expect(result.body).toContain('<select');
    expect(result.body).toContain('value="false" selected');
    f.web.forms.fields = async () => {
      throw new FormInputError('Choose an existing subscription.');
    };
    result = await f.server.inject({
      url: '/github/form',
      headers: { cookie: `buzz_session=${session}` },
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('Choose an existing subscription.');
  });

  it('does not resurrect an account signed out while token refresh is in flight', async () => {
    const f = await fixture();
    f.store.saveAccount({
      pubkey: 'person',
      login: 'octocat',
      token: 'old',
      refreshToken: 'refresh',
      expiresAt: 1,
    });
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const pending = f.web.account('person');
    f.store.removeAccount('person');
    complete(
      Response.json({
        access_token: 'fresh',
        refresh_token: 'new-refresh',
        expires_in: 28800,
      }),
    );
    expect(await pending).toBeUndefined();
    expect(f.store.account('person')).toBeUndefined();
  });
  it('stores manifest credentials through the configured executable without rewriting local configuration', async () => {
    const f = await fixture();
    const destination = join(f.dir, 'written.json');
    const writer = join(f.dir, 'credential-writer');
    writeFileSync(
      writer,
      `#!${process.execPath}\nlet value='';process.stdin.on('data',chunk=>value+=chunk);process.stdin.on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(destination)},value));\n`,
      { mode: 0o700 },
    );
    f.ctx.config.github = undefined;
    f.ctx.config.setupToken = 'private-setup-token';
    f.ctx.config.githubCredentialsWriter = writer;
    const setup = await f.server.inject(
      '/setup/github?token=private-setup-token',
    );
    expect(setup.statusCode).toBe(200);
    const state = /settings\/apps\/new\?state=([^"&]+)/.exec(setup.body)![1];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          id: 123,
          pem: 'private-key-test',
          client_id: 'client-id',
          client_secret: 'client-secret-test',
          webhook_secret: 'webhook-secret-test',
          slug: 'test-app',
        }),
      ),
    );
    const result = await f.server.inject(
      `/setup/github/callback?state=${state}&code=manifest-code`,
    );
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({
      appId: '123',
      privateKey: 'private-key-test',
      clientId: 'client-id',
      clientSecret: 'client-secret-test',
      webhookSecret: 'webhook-secret-test',
    });
    expect(f.ctx.config.github?.appId).toBe('123');
    expect(f.ctx.config.setupToken).toBeUndefined();
    expect(
      (
        await f.server.inject(
          `/setup/github/callback?state=${state}&code=manifest-code`,
        )
      ).statusCode,
    ).toBe(403);
  });

  it('link previews do not consume a sign-in link; explicit continuation does', async () => {
    const f = await fixture();
    const link = new URL(await f.web.link('signin', f.message));
    expect((await f.server.inject(link.pathname)).statusCode).toBe(200);
    expect((await f.server.inject(link.pathname)).statusCode).toBe(200);
    const result = await f.server.inject({
      method: 'POST',
      url: link.pathname,
    });
    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toContain(
      'github.com/login/oauth/authorize',
    );
    expect(
      (await f.server.inject({ method: 'POST', url: link.pathname }))
        .statusCode,
    ).toBe(400);
  });
  it('rejects OAuth callbacks without the initiating browser cookie', async () => {
    const f = await fixture();
    const link = new URL(await f.web.link('signin', f.message));
    const r = await f.server.inject({ method: 'POST', url: link.pathname });
    const state = new URL(r.headers.location!).searchParams.get('state');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(
      (await f.server.inject(`/github/callback?state=${state}&code=fake`))
        .statusCode,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not expose forms without a private session', async () => {
    const f = await fixture();
    expect((await f.server.inject('/github/form')).statusCode).toBe(400);
    expect(
      (
        await f.server.inject({
          method: 'POST',
          url: '/github/form',
          payload: 'x=y',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('escapes provider text in browser HTML', () => {
    expect(escapeHtml('<script>"&')).toBe('&lt;script&gt;&quot;&amp;');
  });
});
