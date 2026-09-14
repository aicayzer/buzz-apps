import Fastify, { LogController } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createGithubForms } from '../apps/github/forms.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './core/store.js';
import { WebFlows, page } from './core/web.js';
import { BuzzClient } from './buzz/client.js';
import { createGithubApp } from '../apps/github/index.js';
import type { AppContext, BuzzTransport, Config } from './core/types.js';

export function validSignature(
  body: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !/^sha256=[a-f\d]{64}$/.test(signature)) return false;
  const expected =
    'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
export async function startService(
  config: Config,
): Promise<{ address: string; close(): Promise<void> }> {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(config.dataDir, {
    lockfilePath: join(config.dataDir, '.service.lock'),
    retries: 0,
    stale: 30_000,
    update: 10_000,
  });
  let cleanup: () => Promise<void> = release;
  try {
    const store = new Store(config.dataDir, config.encryptionKey);
    cleanup = async () => {
      store.close();
      await release();
    };
    const server = Fastify({
      bodyLimit: 10 * 1024 * 1024,
      logger: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.token',
          '*.privateKey',
          '*.clientSecret',
        ],
      },
      logController: new LogController({ disableRequestLogging: true }),
    });
    cleanup = async () => {
      await server.close();
      store.close();
      await release();
    };
    const client = config.enabledApps.includes('github')
      ? new BuzzClient(config, store, server.log)
      : undefined;
    cleanup = async () => {
      await client?.close();
      await server.close();
      store.close();
      await release();
    };
    const unavailable = async (): Promise<never> => {
      throw new Error('Enable the GitHub app first');
    };
    const buzz: BuzzTransport = client ?? {
      pubkey: '',
      send: unavailable,
      dm: unavailable,
      query: unavailable,
      canManage: unavailable,
    };
    const ctx: AppContext = { config, store, buzz, log: server.log };
    const web = new WebFlows(ctx);
    ctx.link = web.link.bind(web);
    ctx.account = web.account.bind(web);
    const github = createGithubApp(ctx);
    web.forms = createGithubForms(ctx, github);
    server.removeContentTypeParser('application/json');
    server.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    server.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) =>
        done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    await server.register(rateLimit, { max: 120, timeWindow: '1 minute' });
    web.routes(server);
    server.get('/health', async () => ({
      ok: true,
      githubConfigured: !!config.github,
    }));
    server.get('/ready', async (_request, reply) => {
      const failed =
        (store.counts().failed ?? 0) +
        store.list('github:summary-errors').length;
      const transport = client?.status();
      const transportFailures = transport?.failed ?? 0;
      const ok =
        (!config.enabledApps.includes('github') ||
          (!!config.github && clientStarted && !!transport?.admitted)) &&
        failed === 0 &&
        transportFailures === 0;
      return reply.code(ok ? 200 : 503).send({
        ok,
        enabledApps: config.enabledApps,
        githubConfigured: !!config.github,
        failedJobs: failed,
        failedDeliveries: transportFailures,
        transport,
      });
    });
    server.post('/webhooks/github', async (request, reply) => {
      if (!config.github || !config.enabledApps.includes('github'))
        return reply.code(503).send({ error: 'GitHub app is not configured' });
      const body = request.body as Buffer;
      const signature = request.headers['x-hub-signature-256'];
      if (
        !Buffer.isBuffer(body) ||
        !validSignature(
          body,
          typeof signature === 'string' ? signature : undefined,
          config.github.webhookSecret,
        )
      )
        return reply.code(401).send({ error: 'Invalid webhook signature' });
      const delivery = request.headers['x-github-delivery'];
      const event = request.headers['x-github-event'];
      if (
        typeof delivery !== 'string' ||
        delivery.length > 128 ||
        typeof event !== 'string' ||
        event.length > 64
      )
        return reply.code(400).send({ error: 'Missing delivery headers' });
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'Invalid JSON' });
      }
      store.enqueue('github:webhooks', delivery, { event, payload });
      return reply.code(202).send({ accepted: true });
    });
    server.setErrorHandler((error, _request, reply) => {
      // Provider exception objects may contain access tokens or private response bodies.
      server.log.error(
        { code: (error as { code?: string }).code ?? 'request_failed' },
        'Request failed',
      );
      const status = (error as { statusCode?: number }).statusCode;
      const code = status && status >= 400 && status < 500 ? status : 500;
      return reply
        .code(code)
        .type('text/html')
        .send(
          page(
            'Unable to complete the request',
            code === 429
              ? '<p>Too many requests. Try again shortly.</p>'
              : code < 500
                ? '<p>The request was not accepted. Check its format and try again.</p>'
                : '<p>The operation could not be completed. Check the result in GitHub before attempting a write again. The operator can inspect service health.</p>',
          ),
        );
    });
    let busy = false,
      closing = false,
      clientStarted = false;
    async function startClient() {
      if (!client || clientStarted) return;
      try {
        await client.start(async (message) => {
          await github.onMessage(message);
        });
        clientStarted = true;
      } catch {
        server.log.warn(
          'Buzz is unavailable; setup remains available and connection will be retried.',
        );
      }
    }
    async function work() {
      if (busy || closing) return;
      busy = true;
      try {
        web.purgeExpired();
        await startClient();
        if (clientStarted) await client?.flush();
        if (config.enabledApps.includes('github') && config.github) {
          for (let i = 0; i < 20; i++) {
            const job = store.take('github:webhooks');
            if (!job) break;
            try {
              const input = job.payload as { event: string; payload: unknown };
              await github.onWebhook!(input.event, input.payload, job.id);
              store.complete(job);
            } catch (error) {
              const status = (error as { status?: number }).status;
              const retryable = !status || status === 429 || status >= 500;
              store.fail(
                job,
                'GitHub webhook processing failed',
                retryable && job.attempts < 10
                  ? Math.min(3600_000, 1000 * 2 ** job.attempts)
                  : undefined,
              );
              server.log.error(
                { delivery: job.id, status },
                'Webhook processing failed',
              );
              break;
            }
          }
          await github.tick?.();
        }
      } catch {
        server.log.error(
          'Background work failed; retained work will be retried',
        );
      } finally {
        busy = false;
      }
    }
    const address = await server.listen({
      host: config.host,
      port: config.port,
    });
    const timer = setInterval(() => void work(), 2000);
    timer.unref();
    // Setup and health remain usable even when the relay is temporarily unavailable.
    void work();
    let closed = false;
    return {
      address,
      async close() {
        if (closed) return;
        closed = true;
        closing = true;
        clearInterval(timer);
        while (busy) await new Promise((r) => setTimeout(r, 20));
        await cleanup();
      },
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Service startup and cleanup failed.',
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
