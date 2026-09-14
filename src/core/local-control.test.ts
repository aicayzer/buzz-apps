import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import {
  localControl,
  sendControl,
  authorisedControlEvent,
} from './local-control.js';
import { Store } from './store.js';
import type { AppContext } from './types.js';
import { GithubApi } from '../../apps/github/api.js';
const key = generateSecretKey();
const signed = (content: string, created_at = Math.floor(Date.now() / 1000)) =>
  finalizeEvent(
    {
      kind: 27235,
      created_at,
      content,
      tags: [
        ['audience', 'wss://example.test'],
        ['channel', 'room'],
      ],
    },
    key,
  );
afterEach(() => vi.restoreAllMocks());
test('control requires signed, current, relay-bound configuration requests', () => {
  const event = signed('summaries list');
  expect(authorisedControlEvent(event, 'wss://example.test')).toBe(true);
  expect(
    authorisedControlEvent(
      JSON.parse(JSON.stringify({ ...event, content: 'status' })),
      'wss://example.test',
    ),
  ).toBe(false);
  expect(authorisedControlEvent(event, 'wss://other.test')).toBe(false);
  expect(
    authorisedControlEvent(signed('status', 1), 'wss://example.test'),
  ).toBe(false);
  expect(
    authorisedControlEvent(
      signed('issue owner/repo#1 close'),
      'wss://example.test',
    ),
  ).toBe(false);
});
test('real socket saves quietly, rejects replay and preserves channel permissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buzz-control-'));
  const store = new Store(dir, 'a'.repeat(64));
  const canManage = vi.fn().mockResolvedValue(true);
  const send = vi.fn(),
    dm = vi.fn();
  vi.spyOn(GithubApi.prototype, 'account').mockResolvedValue({
    login: 'person',
  } as any);
  const ctx = {
    config: {
      dataDir: dir,
      relayUrl: 'wss://example.test',
      enabledApps: ['github'],
    },
    store,
    buzz: { pubkey: 'bot', canManage, send, dm, query: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AppContext;
  const close = await localControl(ctx);
  try {
    expect(statSync(join(dir, 'control.sock')).mode & 0o777).toBe(0o600);
    const event = signed(
      'summaries set daily --cadence daily --scope personal --time 09:00 --destination here',
    );
    expect((await sendControl(dir, event)).join()).toContain('Summary saved');
    expect(store.get('github:summaries', `${event.pubkey}:daily`)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(dm).not.toHaveBeenCalled();
    await expect(sendControl(dir, event)).rejects.toThrow('already submitted');
    canManage.mockResolvedValue(false);
    await expect(
      sendControl(
        dir,
        signed(
          'summaries set denied --cadence daily --scope personal --time 09:00 --destination here',
        ),
      ),
    ).rejects.toThrow();
    expect(
      store.get('github:summaries', `${event.pubkey}:denied`),
    ).toBeUndefined();
  } finally {
    await close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
