import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { validTimezone } from './timezone.js';
import type { Config } from './types.js';

const schema = z.object({
  githubContributionTokens: z
    .record(z.string().regex(/^[a-f\d]{64}$/i), z.string().min(1))
    .optional(),
  timezone: z
    .string()
    .refine((v) => {
      try {
        validTimezone(v);
        return true;
      } catch {
        return false;
      }
    }, 'Invalid timezone')
    .default('UTC'),
  secretCommand: z.array(z.string().min(1)).min(1).optional(),
  githubCredentialsWriter: z
    .string()
    .refine(isAbsolute, 'Expected an absolute executable path')
    .optional(),
  relayUrl: z
    .url()
    .refine((v) => /^(wss?|https?):/.test(v), 'Expected a Buzz relay URL'),
  identities: z
    .record(
      z.string(),
      z.object({ botKey: z.string().min(1), authTag: z.string().optional() }),
    )
    .default({}),
  setupToken: z.string().optional(),
  dataDir: z.string().min(1),
  publicUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  }, 'Expected an HTTPS origin without a path or credentials (HTTP is allowed on loopback).'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8787),
  encryptionKey: z
    .string()
    .regex(/^[a-f\d]{64}$/i, 'Expected 32 random bytes in hexadecimal'),
  enabledApps: z.array(z.enum(['github'])).default([]),
  admins: z.array(z.string().regex(/^[a-f\d]{64}$/i)).default([]),
  github: z
    .object({
      appId: z.string().min(1),
      privateKey: z.string().min(1),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      webhookSecret: z.string().min(16),
    })
    .optional(),
});
const configPaths = new WeakMap<Config, string>();
export function sourceConfigPath(config: Config): string {
  return configPaths.get(config) ?? defaultConfigPath();
}
export function defaultConfigPath(): string {
  return (
    process.env.BUZZ_APPS_CONFIG ??
    join(homedir(), '.config', 'buzz-apps', 'config.json')
  );
}
export function parseConfigurationJson<T = Record<string, unknown>>(
  encoded: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    // Native JSON errors can quote fragments of credentials from the input.
    throw new Error('Invalid configuration JSON. Check its syntax.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Configuration JSON must contain an object.');
  return value as T;
}
export function loadConfig(path = defaultConfigPath()): Config {
  const raw = parseConfigurationJson(readFileSync(path, 'utf8'));
  const overrides: Record<string, unknown> = {};
  if (raw.secretCommand) {
    const command = z.array(z.string().min(1)).min(1).parse(raw.secretCommand);
    try {
      const encoded = execFileSync(command[0], command.slice(1), {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const values = z
        .object({
          encryptionKey: z.unknown().optional(),
          githubContributionTokens: z.unknown().optional(),
          identities: z.unknown().optional(),
          github: z.unknown().optional(),
        })
        .strict()
        .parse(JSON.parse(encoded));
      Object.assign(overrides, values);
    } catch {
      throw new Error(
        'The configured secret provider failed. Check its executable, authentication and JSON output.',
      );
    }
  }
  for (const [env, field] of Object.entries({
    BUZZ_APPS_ENCRYPTION_KEY: 'encryptionKey',
    BUZZ_APPS_RELAY_URL: 'relayUrl',
    BUZZ_APPS_PUBLIC_URL: 'publicUrl',
    BUZZ_APPS_DATA_DIR: 'dataDir',
  })) {
    if (process.env[env]) overrides[field] = process.env[env];
  }
  if (process.env.BUZZ_APPS_GITHUB_CONFIG)
    overrides.github = parseConfigurationJson(
      process.env.BUZZ_APPS_GITHUB_CONFIG,
    );
  const config = schema.parse({ ...raw, ...overrides });
  if (process.env.BUZZ_APPS_GITHUB_BOT_KEY)
    config.identities.github = { botKey: process.env.BUZZ_APPS_GITHUB_BOT_KEY };
  for (const app of config.enabledApps)
    if (!config.identities[app])
      throw new Error(`Missing identity for enabled app: ${app}`);
  config.dataDir = resolve(config.dataDir);
  config.publicUrl = config.publicUrl.replace(/\/$/, '');
  configPaths.set(config, resolve(path));
  return config;
}
