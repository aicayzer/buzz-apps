import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let directory: string;
let originalArgs: string[];
let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), 'buzz-cli-json-'));
  originalArgs = process.argv;
  originalExitCode = process.exitCode;
});
afterEach(() => {
  process.argv = originalArgs;
  process.exitCode = originalExitCode;
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['setup', 'enable'] as const)(
  'never prints malformed secret JSON from %s input',
  async (command) => {
    const config = join(directory, 'config.json');
    const input = join(directory, 'github.json');
    const secret = 'fixture-sensitive-token';
    writeFileSync(input, `{"clientSecret":${secret}}`);
    if (command === 'enable')
      writeFileSync(
        config,
        JSON.stringify({
          relayUrl: 'wss://relay.example',
          publicUrl: 'https://apps.example',
          dataDir: join(directory, 'data'),
          encryptionKey: '11'.repeat(32),
          identities: {},
          enabledApps: [],
          admins: [],
        }),
      );
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = [
      process.execPath,
      'buzz-apps',
      '--config',
      config,
      '--json',
      command,
      ...(command === 'enable' ? ['github'] : []),
      '--input',
      input,
    ];
    await import('./main.js');
    await vi.waitFor(() => expect(output).toHaveBeenCalled());
    const text = output.mock.calls.flat().join('\n');
    expect(JSON.parse(text).error).toBe(
      'Invalid configuration JSON. Check its syntax.',
    );
    expect(text).not.toContain('fixture-sensitive');
    expect(process.exitCode).toBe(1);
  },
);

it.each([true, false])(
  'routes update version and shared flags correctly (globals first: %s)',
  async (globalsFirst) => {
    const config = join(directory, 'missing-config.json');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = [
      process.execPath,
      'buzz-apps',
      ...(globalsFirst ? ['--config', config] : []),
      'update',
      '--version',
      '0.1.0-rc.3',
      ...(!globalsFirst ? ['--config', config] : []),
    ];
    await import('./main.js');
    await vi.waitFor(() => expect(output).toHaveBeenCalled());
    const result = JSON.parse(output.mock.calls.flat().join('\n'));
    expect(result.error).toContain('missing-config.json');
    expect(process.exitCode).toBe(1);
  },
);
