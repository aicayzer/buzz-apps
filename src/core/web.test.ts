import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebFlows, escapeHtml } from './web.js';
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
  return { store, server, web, message };
}
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
  vi.unstubAllGlobals();
});
describe('private browser flows', () => {
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
