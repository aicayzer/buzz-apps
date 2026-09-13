#!/usr/bin/env node
import { Command } from 'commander';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { loadConfig, defaultConfigPath } from '../core/config.js';
import type { Config } from '../core/types.js';
import { controlService, installService, serviceInstalled } from './service.js';
import { rollbackRelease, updateRelease } from './releases.js';

const program = new Command()
  .name('buzz-apps')
  .description('Install and run community apps for Buzz.')
  .version('0.1.0-rc.1')
  .option('--config <path>', 'External configuration file', defaultConfigPath())
  .option('--json', 'Machine-readable output');
function options(): { config: string; json?: boolean } {
  return program.opts();
}
function output(value: unknown): void {
  console.log(JSON.stringify(value, null, options().json ? undefined : 2));
}
function writeConfig(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.tmp-' + process.pid;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  try {
    loadConfig(temporary);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
function config(): Config {
  return loadConfig(resolve(options().config));
}
program
  .command('setup')
  .description('Configure the shared service; apps are enabled separately.')
  .option(
    '--input <path>',
    'Read configuration fields from a JSON file; never prompts',
  )
  .option('--relay <url>', 'Buzz relay WebSocket URL')
  .option('--public-url <url>', 'Public HTTPS service URL')
  .option('--admin <pubkey>', 'Buzz operator public key')
  .action(async (args) => {
    const path = resolve(options().config);
    if (existsSync(path)) {
      const current = config();
      output({
        configured: true,
        config: path,
        apps: current.enabledApps,
        next: 'Run buzz-apps doctor.',
      });
      return;
    }
    const input = args.input
      ? (JSON.parse(
          readFileSync(resolve(args.input), 'utf8'),
        ) as Partial<Config>)
      : {};
    let relayUrl = args.relay || input.relayUrl || process.env.BUZZ_RELAY_URL;
    let publicUrl =
      args.publicUrl || input.publicUrl || process.env.BUZZ_APPS_PUBLIC_URL;
    let admin = args.admin || input.admins?.[0] || process.env.BUZZ_APPS_ADMIN;
    if (
      (!relayUrl || !publicUrl || !admin) &&
      process.stdin.isTTY &&
      !args.input &&
      !options().json
    ) {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        relayUrl ||= await prompt.question('Buzz relay URL (wss://): ');
        publicUrl ||= await prompt.question('Public service URL (https://): ');
        admin ||= await prompt.question('Your Buzz public key (hex): ');
      } finally {
        prompt.close();
      }
    }
    if (!relayUrl || !publicUrl || !admin)
      throw new Error(
        'Setup requires --relay, --public-url and --admin (or --input JSON). Non-interactive setup never prompts.',
      );
    if (!['wss:', 'ws:'].includes(new URL(relayUrl).protocol))
      throw new Error('Relay URL must use wss:// or ws://.');
    if (!['https:', 'http:'].includes(new URL(publicUrl).protocol))
      throw new Error(
        'Public URL must use https:// (http:// is for local development).',
      );
    if (!/^[a-f0-9]{64}$/i.test(admin))
      throw new Error(
        'Admin must be a 64-character hexadecimal Buzz public key.',
      );
    const created: Config = {
      ...input,
      relayUrl,
      publicUrl: publicUrl.replace(/\/$/, ''),
      identities: {},
      admins: input.admins || [admin],
      dataDir: input.dataDir || join(homedir(), '.local/share/buzz-apps/data'),
      host: input.host || '127.0.0.1',
      port: input.port || 8080,
      encryptionKey: input.encryptionKey || randomBytes(32).toString('hex'),
      enabledApps: [],
    };
    delete created.github;
    delete created.setupToken;
    writeConfig(path, created);
    try {
      loadConfig(path);
    } catch {
      throw new Error(
        'Configuration was written but failed validation. Check the external config before starting.',
      );
    }
    output({
      configured: true,
      config: path,
      enabledApps: [],
      next: 'Run buzz-apps enable github to configure the GitHub identity and integration.',
    });
  });
program
  .command('enable <app>')
  .description('Configure and enable an app with its own bot identity.')
  .option(
    '--input <path>',
    'App-specific JSON with botKey, authTag and optional github credentials',
  )
  .action((app: string, args) => {
    if (app !== 'github')
      throw new Error('Unknown app. This release includes github.');
    const effective = config();
    const path = resolve(options().config);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Config;
    const input = args.input
      ? (JSON.parse(readFileSync(resolve(args.input), 'utf8')) as {
          botKey?: string;
          authTag?: string;
          github?: Config['github'];
        })
      : {};
    const existing = effective.identities.github;
    raw.identities ||= {};
    const botKey =
      input.botKey ||
      process.env.BUZZ_APPS_GITHUB_BOT_KEY ||
      existing?.botKey ||
      Buffer.from(generateSecretKey()).toString('hex');
    if (!/^[a-f0-9]{64}$/i.test(botKey))
      throw new Error('Bot key must be 64-character hexadecimal.');
    if (
      !raw.secretCommand ||
      input.botKey ||
      process.env.BUZZ_APPS_GITHUB_BOT_KEY
    )
      raw.identities.github = {
        botKey,
        ...(input.authTag || existing?.authTag
          ? { authTag: input.authTag || existing?.authTag }
          : {}),
      };
    if (input.github) raw.github = input.github;
    raw.setupToken ||= randomBytes(32).toString('hex');
    raw.enabledApps = [...new Set([...raw.enabledApps, app])];
    writeConfig(path, raw);
    loadConfig(path);
    output({
      enabledApps: raw.enabledApps,
      botPublicKey: getPublicKey(Buffer.from(botKey, 'hex')),
      identity:
        existing || input.botKey || process.env.BUZZ_APPS_GITHUB_BOT_KEY
          ? 'existing'
          : 'new',
      admission:
        'Add this public key to your Buzz relay and invite it to a channel. Doctor verifies admission after the service starts.',
      githubSetup:
        raw.github || effective.github
          ? 'configured'
          : `${raw.publicUrl}/setup/github?token=${raw.setupToken}`,
      restartRequired: true,
    });
  });
program
  .command('disable <app>')
  .description('Disable an app while preserving its configuration and data.')
  .action((app: string) => {
    if (app !== 'github')
      throw new Error('Unknown app. This release includes github.');
    config();
    const path = resolve(options().config);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Config;
    raw.enabledApps = raw.enabledApps.filter((id) => id !== app);
    writeConfig(path, raw);
    output({ enabledApps: raw.enabledApps, restartRequired: true });
  });
program
  .command('start')
  .description('Run the service in the foreground.')
  .action(async () => {
    process.env.BUZZ_APPS_CONFIG = resolve(options().config);
    const { startService } = await import('../service.js');
    const service = await startService(config());
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await service.close();
      process.exitCode = 0;
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => {
        void close().catch(() => {
          console.error('Failed to shut down cleanly.');
          process.exitCode = 1;
        });
      });
  });
const service = program
  .command('service')
  .description('Manage a native background service.');
service
  .command('install')
  .option('--label <label>', 'Custom native service identifier')
  .option(
    '--entrypoint <path>',
    'Compiled CLI path; defaults to this npm installation',
  )
  .action((args) => {
    config();
    installService(resolve(options().config), args.entrypoint, args.label);
    output({
      installed: true,
      next: 'buzz-apps service start',
      persistence:
        process.platform === 'linux'
          ? 'Enable user lingering to keep this service running after logout: loginctl enable-linger USER.'
          : 'Runs in your launchd login session and survives SSH disconnects.',
    });
  });
for (const action of ['start', 'stop', 'restart'] as const)
  service.command(action).action(() => {
    controlService(action);
    output({ action, ok: true });
  });
async function status(): Promise<Record<string, unknown>> {
  const current = config();
  const host =
    current.host === '0.0.0.0' || current.host === '::'
      ? '127.0.0.1'
      : current.host;
  try {
    const response = await fetch(`http://${host}:${current.port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return {
      running: response.ok,
      serviceInstalled: serviceInstalled(),
      ...((await response.json()) as object),
    };
  } catch {
    return { running: false, serviceInstalled: serviceInstalled() };
  }
}
program.command('status').action(async () => {
  const result = await status();
  output(result);
  if (!result.running) process.exitCode = 1;
});
program
  .command('doctor')
  .description('Check configuration and running service readiness.')
  .action(async () => {
    const current = config();
    const checks: Record<string, unknown> = {
      configuration: 'valid',
      github: current.github ? 'configured' : 'registration required',
      identities: Object.fromEntries(
        Object.entries(current.identities).map(([app, identity]) => [
          app,
          getPublicKey(Buffer.from(identity.botKey, 'hex')),
        ]),
      ),
      ...(await status()),
    };
    const host =
      current.host === '0.0.0.0' || current.host === '::'
        ? '127.0.0.1'
        : current.host;
    try {
      const response = await fetch(`http://${host}:${current.port}/ready`, {
        signal: AbortSignal.timeout(10_000),
      });
      checks.ready = response.ok;
      checks.dependencies = await response.json();
    } catch {
      checks.ready = false;
      checks.dependencies =
        'Service unavailable. Start it to check runtime and relay readiness.';
    }
    output(checks);
    if (!checks.ready) process.exitCode = 1;
  });
program
  .command('update')
  .description(
    'Install a release with paired data backup and health-checked recovery.',
  )
  .option(
    '--version <version>',
    'Explicit release, including release candidates',
  )
  .action(async (args) => {
    output({
      release: await updateRelease(
        config(),
        resolve(options().config),
        args.version,
      ),
      updated: true,
    });
  });
program
  .command('rollback')
  .description(
    'Restore the previous release and its matching data/config backup.',
  )
  .action(async () => {
    await rollbackRelease(config());
    output({ restored: true });
  });
program.parseAsync().catch((error: unknown) => {
  output({ error: error instanceof Error ? error.message : 'Command failed.' });
  process.exitCode = 1;
});
