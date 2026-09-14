import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { Octokit } from 'octokit';
import type { Account, AppContext, Config, Message } from './types.js';
import { sourceConfigPath } from './config.js';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export type LinkPurpose =
  'signin' | 'settings' | 'open' | 'reminders' | 'issue-edit' | 'summaries';
export interface LinkRecord {
  purpose: LinkPurpose;
  message: Message;
  data: Record<string, unknown>;
  expires: number;
}
interface PendingRegistration {
  github: NonNullable<Config['github']>;
  slug: string;
  stateHash: string;
}
export class FormInputError extends Error {}
export interface FormField {
  name: string;
  label: string;
  value?: string;
  type?: string;
  readonly?: boolean;
  required?: boolean;
  options?: { value: string; label: string }[];
}
export interface FormHandler {
  isPreview?(record: LinkRecord, values: Record<string, string>): boolean;
  fields(record: LinkRecord): Promise<{
    title: string;
    fields: FormField[];
    links?: { label: string; url: string }[];
  }>;
  submit(record: LinkRecord, values: Record<string, string>): Promise<string>;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} | Buzz Apps</title><style>body{font:17px/1.6 system-ui,sans-serif;background:#f5f6f8;color:#172032;margin:0;padding:40px 20px}main{max-width:640px;margin:4vh auto;background:white;padding:36px;border:1px solid #dfe3e8;border-radius:12px}h1{font-size:26px;line-height:1.2}label{display:block;font-weight:600;margin-top:20px}input,textarea,select{box-sizing:border-box;width:100%;font:inherit;padding:10px;border:1px solid #8993a1;border-radius:5px}textarea{min-height:120px}button,.button{display:inline-block;background:#173bba;color:white;border:0;border-radius:5px;padding:12px 20px;font:inherit;margin-top:24px;text-decoration:none;cursor:pointer}a{color:#173bba}small{color:#566176}code{overflow-wrap:anywhere}</style><main><small>Buzz Apps / GitHub</small><h1>${escapeHtml(title)}</h1>${body}</main></html>`;
}
function renderField(field: FormField): string {
  const name = escapeHtml(field.name),
    value = escapeHtml(field.value ?? '');
  const attributes = `id="${name}" name="${name}"${field.required ? ' required' : ''}${field.readonly ? ' readonly' : ''}`;
  let control: string;
  if (field.options)
    control = `${field.readonly ? `<input type="hidden" name="${name}" value="${value}">` : ''}<select ${attributes}${field.readonly ? ' disabled' : ''}>${field.options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === field.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`;
  else if (field.type === 'textarea')
    control = `<textarea ${attributes}>${value}</textarea>`;
  else
    control = `<input ${attributes} type="${['text', 'number', 'time', 'date'].includes(field.type ?? 'text') ? (field.type ?? 'text') : 'text'}" value="${value}">`;
  return `<label for="${name}">${escapeHtml(field.label)}</label>${control}`;
}
function fail(reply: FastifyReply, message: string, status = 400) {
  return reply
    .code(status)
    .type('text/html')
    .send(page('Unable to continue', `<p>${escapeHtml(message)}</p>`));
}
function same(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class WebFlows {
  private refreshing = new Map<string, Promise<Account | undefined>>();
  forms?: FormHandler;
  private registering = false;
  private savingRegistration = false;
  constructor(private ctx: AppContext) {
    if (ctx.config.github) ctx.store.delete('github:setup-secrets', 'pending');
  }
  purgeExpired(): void {
    for (const space of [
      'web:links',
      'web:oauth',
      'web:sessions',
      'web:setup',
    ]) {
      for (const { key, value } of this.ctx.store.list<{ expires: number }>(
        space,
      )) {
        if (value.expires < Date.now()) this.ctx.store.delete(space, key);
      }
    }
    for (const { key } of this.ctx.store.list('web:csrf')) {
      if (!this.ctx.store.get('web:sessions', key))
        this.ctx.store.delete('web:csrf', key);
    }
  }
  async link(
    purpose: LinkPurpose,
    message: Message,
    data: Record<string, unknown> = {},
  ): Promise<string> {
    const token = nonce();
    this.ctx.store.set('web:links', hash(token), {
      purpose,
      message,
      data,
      expires: Date.now() + 15 * 60_000,
    } satisfies LinkRecord);
    return `${this.ctx.config.publicUrl}/github/link/${token}`;
  }
  private async oauth(body: Record<string, string>): Promise<any> {
    const g = this.ctx.config.github;
    if (!g) throw new Error('GitHub App setup is incomplete');
    const response = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: g.clientId,
          client_secret: g.clientSecret,
          ...body,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const value = (await response.json()) as any;
    if (!response.ok || value.error || !value.access_token)
      throw new Error('GitHub did not authorise the connection');
    return value;
  }
  async account(pubkey: string): Promise<Account | undefined> {
    const existing = this.ctx.store.account(pubkey);
    if (!existing) return;
    if (!existing.expiresAt || existing.expiresAt > Date.now() + 60_000)
      return existing;
    if (!existing.refreshToken) {
      this.ctx.store.removeAccount(pubkey);
      return;
    }
    if (this.refreshing.has(pubkey)) return this.refreshing.get(pubkey);
    const pending = (async () => {
      const token = await this.oauth({
        grant_type: 'refresh_token',
        refresh_token: existing.refreshToken!,
      });
      const account = {
        ...existing,
        token: token.access_token,
        refreshToken: token.refresh_token ?? existing.refreshToken,
        expiresAt: Date.now() + Number(token.expires_in ?? 28800) * 1000,
      };
      const current = this.ctx.store.account(pubkey);
      if (!current || current.token !== existing.token) return current;
      this.ctx.store.saveAccount(account);
      return account;
    })();
    this.refreshing.set(pubkey, pending);
    try {
      return await pending;
    } finally {
      this.refreshing.delete(pubkey);
    }
  }
  routes(server: FastifyInstance): void {
    const ctx = this.ctx;
    server.addHook('onSend', async (request, reply, payload) => {
      reply
        .header('Referrer-Policy', 'no-referrer')
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'",
        );
      return payload;
    });
    server.get('/github/link/:token', async (request, reply) => {
      const { token } = request.params as { token: string };
      const record = ctx.store.get<LinkRecord>('web:links', hash(token));
      if (!record || record.expires < Date.now())
        return fail(reply, 'This link has expired. Request a new one in Buzz.');
      if (!ctx.config.github)
        return fail(
          reply,
          'The operator must finish GitHub App setup first.',
          503,
        );
      // Consume the DM capability only on an explicit POST, so link scanners cannot use it.
      return reply
        .type('text/html')
        .send(
          page(
            'Continue with GitHub',
            `<p>Connect your GitHub account to this Buzz identity to ${record.purpose === 'signin' ? 'sign in' : 'continue'}. This link expires shortly.</p><form method="post"><button>Continue to GitHub</button></form>`,
          ),
        );
    });
    server.post('/github/link/:token', async (request, reply) => {
      const { token } = request.params as { token: string };
      const key = hash(token);
      const record = ctx.store.get<LinkRecord>('web:links', key);
      if (!record || record.expires < Date.now())
        return fail(reply, 'This link has expired. Request a new one in Buzz.');
      const g = ctx.config.github;
      if (!g) return fail(reply, 'GitHub App setup is incomplete', 503);
      const state = nonce();
      const verifier = nonce();
      ctx.store.delete('web:links', key);
      ctx.store.set('web:oauth', hash(state), {
        record,
        verifier,
        expires: Date.now() + 10 * 60_000,
      });
      reply.header(
        'Set-Cookie',
        `buzz_oauth=${verifier}; HttpOnly; SameSite=Lax; Path=/github; Max-Age=600${ctx.config.publicUrl.startsWith('https:') ? '; Secure' : ''}`,
      );
      return reply.redirect(
        `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: g.clientId, state, redirect_uri: `${ctx.config.publicUrl}/github/callback` })}`,
      );
    });
    server.get('/github/callback', async (request, reply) => {
      const { state, code } = request.query as Record<string, string>;
      if (!state || !code)
        return fail(reply, 'GitHub sign-in was cancelled or incomplete.');
      const key = hash(state);
      const flow = ctx.store.get<{
        record: LinkRecord;
        verifier: string;
        expires: number;
      }>('web:oauth', key);
      const cookie = /\bbuzz_oauth=([^;]+)/.exec(
        request.headers.cookie ?? '',
      )?.[1];
      if (
        !flow ||
        flow.expires < Date.now() ||
        !cookie ||
        !same(cookie, flow.verifier)
      )
        return fail(reply, 'This sign-in request is invalid or expired.');
      ctx.store.delete('web:oauth', key);
      const result = await this.oauth({
        code,
        redirect_uri: `${ctx.config.publicUrl}/github/callback`,
      });
      const { data: user } = await new Octokit({
        auth: result.access_token,
      }).rest.users.getAuthenticated();
      const old = ctx.store.account(flow.record.message.author);
      if (
        flow.record.purpose !== 'signin' &&
        old &&
        old.login.toLowerCase() !== user.login.toLowerCase()
      )
        return fail(
          reply,
          'Use the GitHub account already connected to this Buzz identity.',
        );
      ctx.store.saveAccount({
        pubkey: flow.record.message.author,
        login: user.login,
        token: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: result.expires_in
          ? Date.now() + Number(result.expires_in) * 1000
          : undefined,
      });
      if (flow.record.purpose === 'signin') {
        await ctx.buzz.dm(
          flow.record.message.author,
          `Connected GitHub account **${user.login}**. Mention me with \`subscribe OWNER/REPO\` in a channel to set up notifications.`,
        );
        return reply
          .type('text/html')
          .send(
            page(
              'GitHub connected',
              `<p>Signed in as <strong>${escapeHtml(user.login)}</strong>. You can return to Buzz.</p>`,
            ),
          );
      }
      const session = nonce();
      ctx.store.set('web:sessions', hash(session), {
        ...flow.record,
        expires: Date.now() + 15 * 60_000,
      });
      reply.header(
        'Set-Cookie',
        `buzz_session=${session}; HttpOnly; SameSite=Strict; Path=/github; Max-Age=900${ctx.config.publicUrl.startsWith('https:') ? '; Secure' : ''}`,
      );
      return reply.redirect('/github/form');
    });
    const session = (request: FastifyRequest) => {
      const token = /\bbuzz_session=([^;]+)/.exec(
        request.headers.cookie ?? '',
      )?.[1];
      const record = token
        ? ctx.store.get<LinkRecord>('web:sessions', hash(token))
        : undefined;
      return token && record && record.expires > Date.now()
        ? { token, record }
        : undefined;
    };
    server.get('/github/form', async (request, reply) => {
      const s = session(request);
      if (!s)
        return fail(
          reply,
          'This session has expired. Request a new link in Buzz.',
        );
      if (!this.forms) return fail(reply, 'This form is unavailable.', 503);
      let form: Awaited<ReturnType<FormHandler['fields']>>;
      try {
        form = await this.forms.fields(s.record);
      } catch (error) {
        if (error instanceof FormInputError) return fail(reply, error.message);
        throw error;
      }
      const csrf = nonce();
      ctx.store.set('web:csrf', hash(s.token), csrf);
      return reply.type('text/html').send(
        page(
          form.title,
          `${(form.links ?? [])
            .map((link) => {
              const url = new URL(link.url, ctx.config.publicUrl);
              if (!['http:', 'https:'].includes(url.protocol))
                throw new Error('Invalid form link.');
              return `<p><a href="${escapeHtml(url.href)}">${escapeHtml(link.label)}</a></p>`;
            })
            .join(
              '',
            )}${form.fields.length ? `<form method="post"><input type="hidden" name="csrf" value="${csrf}">${form.fields.map(renderField).join('')}<button>Save</button></form>` : ''}`,
        ),
      );
    });
    server.post('/github/form', async (request, reply) => {
      const s = session(request);
      if (!s) return fail(reply, 'This session has expired.');
      const values = request.body as Record<string, string>;
      const csrf = ctx.store.get<string>('web:csrf', hash(s.token));
      if (!values?.csrf || !csrf || !same(values.csrf, csrf))
        return fail(reply, 'The form token is invalid.', 403);
      if (
        request.headers.origin &&
        request.headers.origin !== new URL(ctx.config.publicUrl).origin
      )
        return fail(reply, 'Invalid request origin.', 403);
      if (!this.forms) return fail(reply, 'Form unavailable', 503);
      // A form is a one-use action. Ambiguous provider writes must not be repeated by refreshing.
      const preview = this.forms.isPreview?.(s.record, values) ?? false;
      if (!preview) {
        ctx.store.delete('web:csrf', hash(s.token));
        ctx.store.delete('web:sessions', hash(s.token));
      }
      let result: string;
      try {
        result = await this.forms.submit(s.record, values);
      } catch (error) {
        if (error instanceof FormInputError) {
          if (!preview && s.record.expires > Date.now()) {
            ctx.store.set('web:sessions', hash(s.token), s.record);
            ctx.store.set('web:csrf', hash(s.token), csrf);
          }
          return fail(reply, error.message);
        }
        throw error;
      }
      return reply
        .type('text/html')
        .send(
          page(
            preview ? 'Preview' : 'Saved',
            `<p style="white-space:pre-wrap">${escapeHtml(result)}</p>${preview ? '<p><a href="/github/form">Back to settings</a></p>' : '<p>Return to Buzz to continue.</p>'}`,
          ),
        );
    });
    this.setupRoutes(server);
  }
  private setupRoutes(server: FastifyInstance): void {
    const ctx = this.ctx;
    server.get('/setup/github', async (request, reply) => {
      const { token } = request.query as { token?: string };
      if (
        !token ||
        !ctx.config.setupToken ||
        !same(token, ctx.config.setupToken) ||
        ctx.config.github
      )
        return fail(
          reply,
          'Setup link is invalid or has already been used.',
          403,
        );
      if (
        ctx.store.secret<PendingRegistration>('github:setup-secrets', 'pending')
      ) {
        return reply
          .type('text/html')
          .send(
            page(
              'Finish GitHub App setup',
              `<p>Your GitHub App is registered. Retry saving its credentials to finish setup.</p><form method="post" action="/setup/github/save"><input type="hidden" name="token" value="${escapeHtml(token)}"><button>Save registration</button></form>`,
            ),
          );
      }
      const state = nonce();
      ctx.store.set('web:setup', hash(state), {
        expires: Date.now() + 60 * 60_000,
      });
      const manifest = {
        name: 'Buzz Apps GitHub',
        url: 'https://github.com/aicayzer/buzz-apps',
        hook_attributes: {
          url: `${ctx.config.publicUrl}/webhooks/github`,
          active: true,
        },
        redirect_url: `${ctx.config.publicUrl}/setup/github/callback`,
        callback_urls: [`${ctx.config.publicUrl}/github/callback`],
        setup_url: `${ctx.config.publicUrl}/setup/github/complete`,
        public: false,
        request_oauth_on_install: false,
        default_permissions: {
          contents: 'read',
          metadata: 'read',
          checks: 'read',
          statuses: 'read',
          discussions: 'read',
          issues: 'write',
          pull_requests: 'write',
          actions: 'write',
          deployments: 'write',
          members: 'read',
        },
        default_events: [
          'issues',
          'issue_comment',
          'pull_request',
          'pull_request_review',
          'pull_request_review_comment',
          'push',
          'release',
          'deployment',
          'deployment_status',
          'workflow_run',
          'discussion',
          'discussion_comment',
          'create',
          'delete',
        ],
      };
      return reply
        .type('text/html')
        .send(
          page(
            'Register your GitHub App',
            `<p>GitHub will let you choose a unique app name. Register this app, then install it on the repositories you want to connect.</p><form action="https://github.com/settings/apps/new?state=${state}" method="post"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button>Create GitHub App</button></form>`,
          ),
        );
    });
    server.get('/setup/github/callback', async (request, reply) => {
      const { code, state } = request.query as Record<string, string>;
      const flow = state
        ? ctx.store.get<{ expires: number }>('web:setup', hash(state))
        : undefined;
      if (!flow || flow.expires < Date.now() || ctx.config.github || !code)
        return fail(reply, 'Setup has expired or was already completed.', 403);
      let pending = ctx.store.secret<PendingRegistration>(
        'github:setup-secrets',
        'pending',
      );
      if (pending && pending.stateHash !== hash(state))
        return fail(
          reply,
          'Finish the existing registration using your setup link.',
          409,
        );
      if (!pending) {
        if (this.registering)
          return fail(
            reply,
            'Registration is in progress. Try this link again shortly.',
            409,
          );
        this.registering = true;
        try {
          const response = await fetch(
            `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              },
              signal: AbortSignal.timeout(15000),
            },
          );
          if (!response.ok)
            throw new Error('GitHub App registration could not be completed');
          const app = (await response.json()) as Record<string, unknown>;
          if (
            !app.id ||
            [
              'pem',
              'client_id',
              'client_secret',
              'webhook_secret',
              'slug',
            ].some((key) => typeof app[key] !== 'string' || !app[key])
          )
            throw new Error('GitHub returned incomplete app credentials.');
          pending = {
            github: {
              appId: String(app.id),
              privateKey: app.pem as string,
              clientId: app.client_id as string,
              clientSecret: app.client_secret as string,
              webhookSecret: app.webhook_secret as string,
            },
            slug: app.slug as string,
            stateHash: hash(state),
          };
          ctx.store.saveSecret('github:setup-secrets', 'pending', pending);
        } finally {
          this.registering = false;
        }
      }
      return this.persistRegistration(pending, reply);
    });
    server.post('/setup/github/save', async (request, reply) => {
      const token = (request.body as { token?: string })?.token;
      if (
        !token ||
        !ctx.config.setupToken ||
        !same(token, ctx.config.setupToken) ||
        ctx.config.github
      )
        return fail(reply, 'Setup link is invalid or already used.', 403);
      if (
        request.headers.origin &&
        request.headers.origin !== new URL(ctx.config.publicUrl).origin
      )
        return fail(reply, 'Invalid request origin.', 403);
      const pending = ctx.store.secret<PendingRegistration>(
        'github:setup-secrets',
        'pending',
      );
      if (!pending)
        return fail(
          reply,
          'There is no registration waiting to be saved.',
          400,
        );
      return this.persistRegistration(pending, reply);
    });
    server.get('/setup/github/complete', async (_request, reply) =>
      reply
        .type('text/html')
        .send(
          page(
            'Installation complete',
            '<p>Return to Buzz and mention GitHub with <code>signin</code>, then <code>subscribe OWNER/REPO</code>.</p>',
          ),
        ),
    );
  }
  private async persistRegistration(
    pending: PendingRegistration,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    if (this.savingRegistration)
      return fail(
        reply,
        'Registration is being saved. Try again shortly.',
        409,
      );
    this.savingRegistration = true;
    const ctx = this.ctx;
    const { github } = pending;
    try {
      const writer =
        ctx.config.githubCredentialsWriter ??
        process.env.BUZZ_APPS_GITHUB_CREDENTIALS_WRITER;
      if (writer) {
        if (!isAbsolute(writer))
          throw new Error(
            'Credential writer must be an absolute executable path.',
          );
        await new Promise<void>((resolve, reject) => {
          const child = execFile(
            writer,
            [],
            { timeout: 60_000, maxBuffer: 64 * 1024 },
            (error) => {
              // A credential writer's output can contain secrets; never expose it in exceptions.
              if (error)
                reject(
                  new Error(
                    'Credential storage failed. The operator must inspect the credential writer.',
                  ),
                );
              else resolve();
            },
          );
          child.stdin?.on('error', () =>
            reject(
              new Error(
                'Credential storage could not accept the registration.',
              ),
            ),
          );
          child.stdin?.end(JSON.stringify(github));
        });
      } else {
        const path = sourceConfigPath(ctx.config);
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        raw.github = github;
        delete raw.setupToken;
        const temporary = `${path}.${nonce()}.tmp`;
        writeFileSync(temporary, JSON.stringify(raw, null, 2) + '\n', {
          mode: 0o600,
          flag: 'wx',
        });
        renameSync(temporary, path);
      }
      ctx.config.github = github;
      delete ctx.config.setupToken;
      ctx.store.set('github:app', 'registration', {
        slug: pending.slug,
        id: pending.github.appId,
      });
      ctx.store.delete('github:setup-secrets', 'pending');
      ctx.store.delete('web:setup', pending.stateHash);
      return reply
        .type('text/html')
        .send(
          page(
            'Install on repositories',
            `<p>Your GitHub App is registered. Install it on the repositories you want Buzz to use, then return to Buzz and mention GitHub with <code>signin</code>.</p><a class="button" href="https://github.com/apps/${encodeURIComponent(pending.slug)}/installations/new">Choose repositories</a>`,
          ),
        );
    } finally {
      this.savingRegistration = false;
    }
  }
}
