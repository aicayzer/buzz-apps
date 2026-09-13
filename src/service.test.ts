import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from './core/store.js';
import type { Config } from './core/types.js';
import { startService } from './service.js';

const transport = vi.hoisted(() => ({
  failConstructor: false,
  failStart: false,
  started: 0,
}));
vi.mock('./buzz/client.js', () => ({
  BuzzClient: class {
    pubkey = '01'.repeat(32);
    constructor() {
      if (transport.failConstructor) throw new Error('Invalid identity');
    }
    async start() {
      transport.started += 1;
      if (transport.failStart) throw new Error('Relay unavailable');
    }
    async close() {}
    async flush() {}
    status() {
      return {
        admitted: !transport.failStart,
        connected: !transport.failStart,
        pending: 0,
        failed: 0,
        inbox: 0,
      };
    }
  },
}));

let directory: string;
let config: Config;
let running: Awaited<ReturnType<typeof startService>> | undefined;
beforeEach(() => {
  transport.failConstructor = false;
  transport.failStart = false;
  transport.started = 0;
  directory = mkdtempSync(join(tmpdir(), 'buzz-service-test-'));
  config = {
    identities: {},
    relayUrl: 'https://relay.example',
    encryptionKey: '04'.repeat(32),
    dataDir: directory,
    publicUrl: 'https://apps.example',
    host: '127.0.0.1',
    port: 0,
    enabledApps: [],
    admins: [],
  };
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  rmSync(directory, { recursive: true, force: true });
});
const enabled = (): Config => ({
  ...config,
  enabledApps: ['github'],
  identities: { github: { botKey: '01'.repeat(32) } },
  github: {
    appId: '123',
    privateKey: 'test-only',
    clientId: 'client',
    clientSecret: 'secret',
    webhookSecret: 'test-webhook-secret',
  },
});

describe('service lifecycle and webhook boundary', () => {
  it('runs setup and health without any app identity, then releases the data lock on close', async () => {
    running = await startService(config);
    expect((await fetch(`${running.address}/health`)).status).toBe(200);
    const ready = await fetch(`${running.address}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, enabledApps: [] });
    expect(transport.started).toBe(0);
    await running.close();
    await running.close();
    running = await startService(config);
    expect((await fetch(`${running.address}/health`)).status).toBe(200);
  });

  it('persists verified raw webhook bytes once and rejects unsigned or changed bodies', async () => {
    running = await startService(enabled());
    const body = JSON.stringify({
      action: 'opened',
      issue: { title: 'Unicode café', number: 1 },
    });
    const signature = `sha256=${createHmac('sha256', enabled().github!.webhookSecret).update(body).digest('hex')}`;
    const headers = {
      'content-type': 'application/json',
      'x-github-delivery': 'delivery-123',
      'x-github-event': 'issues',
      'x-hub-signature-256': signature,
    };
    expect(
      (
        await fetch(`${running.address}/webhooks/github`, {
          method: 'POST',
          body,
          headers,
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await fetch(`${running.address}/webhooks/github`, {
          method: 'POST',
          body,
          headers,
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await fetch(`${running.address}/webhooks/github`, {
          method: 'POST',
          body: `${body} `,
          headers,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${running.address}/webhooks/github`, {
          method: 'POST',
          body,
          headers: { ...headers, 'x-hub-signature-256': '' },
        })
      ).status,
    ).toBe(401);
    await running.close();
    running = undefined;
    const persisted = new Store(directory, config.encryptionKey);
    try {
      expect(persisted.counts()).toEqual({ pending: 1 });
      const job = persisted.take('github:webhooks');
      expect(job?.id).toBe('delivery-123');
      expect(job?.payload).toEqual({
        event: 'issues',
        payload: JSON.parse(body),
      });
    } finally {
      persisted.close();
    }
  });

  it('releases the database and lock when app construction fails before listening', async () => {
    transport.failConstructor = true;
    await expect(startService(enabled())).rejects.toThrow('Invalid identity');
    transport.failConstructor = false;
    running = await startService(config);
    expect((await fetch(`${running.address}/health`)).status).toBe(200);
  });

  it('releases resources after a listen failure', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, '127.0.0.1', resolve),
    );
    try {
      const port = (blocker.address() as { port: number }).port;
      await expect(startService({ ...config, port })).rejects.toThrow();
      running = await startService(config);
      expect((await fetch(`${running.address}/health`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('keeps setup reachable and reports not ready when Buzz is unavailable', async () => {
    transport.failStart = true;
    running = await startService(enabled());
    expect((await fetch(`${running.address}/health`)).status).toBe(200);
    expect((await fetch(`${running.address}/ready`)).status).toBe(503);
    expect(transport.started).toBeGreaterThan(0);
  });
});
