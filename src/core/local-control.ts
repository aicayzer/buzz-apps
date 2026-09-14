import { createServer, request } from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { verifyEvent, type Event } from 'nostr-tools';
import type { AppContext } from './types.js';
import { createGithubApp, tokenize } from '../../apps/github/index.js';

export function authorisedControlEvent(
  event: Event,
  relay: string,
  now = Date.now(),
): boolean {
  try {
    return (
      verifyEvent(event) &&
      event.kind === 27235 &&
      Math.abs(now / 1000 - event.created_at) < 60 &&
      event.tags.some((t) => t[0] === 'audience' && t[1] === relay) &&
      event.tags.some((t) => t[0] === 'channel' && !!t[1]) &&
      ['summaries', 'status'].includes(tokenize(event.content)[0])
    );
  } catch {
    return false;
  }
}
export async function localControl(
  ctx: AppContext,
): Promise<() => Promise<void>> {
  const path = join(ctx.config.dataDir, 'control.sock');
  // The service data-directory lock is held before removing a stale socket.
  rmSync(path, { force: true });
  const server = createServer(async (req, res) => {
    const respond = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST' || req.url !== '/github') {
      respond(404, { error: 'Unknown operation' });
      return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 32768) throw new Error('Request too large');
      }
      const event = JSON.parse(body) as Event;
      if (
        !ctx.config.enabledApps.includes('github') ||
        !authorisedControlEvent(event, ctx.config.relayUrl)
      ) {
        respond(403, {
          error: 'A fresh signed command for this relay is required.',
        });
        return;
      }
      // Local commands do not arrive through relay channel admission checks.
      // Restrict this operator interface to a manager of the supplied channel.
      const channel = event.tags.find((t) => t[0] === 'channel')![1];
      if (!(await ctx.buzz.canManage(channel, event.pubkey))) {
        respond(403, { error: 'Channel management permission is required.' });
        return;
      }
      if (!ctx.store.once('local-control', event.id, event.created_at)) {
        respond(409, {
          error: 'Command already submitted. Inspect settings before retrying.',
        });
        return;
      }
      for (const row of ctx.store.list<number>('local-control'))
        if (row.value < Date.now() / 1000 - 120)
          ctx.store.delete('local-control', row.key);
      const messages: string[] = [];
      let failed = false;
      const capture = async (_to: string, text: string) => {
        if (
          ![
            'I sent you a private link.',
            'Your GitHub setup has been sent privately.',
            'The summary preview has been sent privately.',
          ].includes(text)
        )
          messages.push(text);
        return 'local';
      };
      const app = createGithubApp({
        ...ctx,
        buzz: {
          pubkey: ctx.buzz.pubkey,
          query: ctx.buzz.query.bind(ctx.buzz),
          canManage: ctx.buzz.canManage.bind(ctx.buzz),
          channelName: ctx.buzz.channelName?.bind(ctx.buzz),
          send: capture,
          dm: capture,
        },
        log: {
          ...ctx.log,
          warn: () => {
            failed = true;
          },
        },
      });
      await app.onMessage({
        id: event.id,
        author: event.pubkey,
        channel: event.tags.find((t) => t[0] === 'channel')![1],
        content: event.content,
        tags: [['p', ctx.buzz.pubkey]],
        createdAt: event.created_at,
      });
      respond(failed ? 400 : 200, { messages });
    } catch {
      respond(400, {
        error:
          'Unable to process command. Check its arguments and inspect settings before retrying.',
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => {
        rmSync(path, { force: true });
        if (error) reject(error);
        else resolve();
      }),
    );
}
export async function sendControl(
  dataDir: string,
  event: Event,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: join(dataDir, 'control.sock'),
        path: '/github',
        method: 'POST',
        timeout: 30000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const value = JSON.parse(body);
            if (res.statusCode !== 200)
              reject(
                new Error(
                  value.error ?? value.messages?.join('\n') ?? 'Command failed',
                ),
              );
            else resolve(value.messages);
          } catch {
            reject(new Error('Invalid service response'));
          }
        });
      },
    );
    req.on('timeout', () =>
      req.destroy(
        new Error('Command timed out. Inspect settings before retrying.'),
      ),
    );
    req.on('error', reject);
    req.end(JSON.stringify(event));
  });
}
