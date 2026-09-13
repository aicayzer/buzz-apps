import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, sourceConfigPath } from './config.js';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'buzz-config-test-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const base = () => ({
  relayUrl: 'https://relay.example',
  publicUrl: 'https://apps.example',
  dataDir: directory,
  encryptionKey: '00'.repeat(32),
  identities: {},
  enabledApps: [],
});
function write(value: unknown): string {
  const path = join(directory, 'chosen-config.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('external credential configuration', () => {
  it('requires an HTTPS public origin and rejects credentials, paths and query strings', () => {
    for (const publicUrl of [
      'http://public.example',
      'https://user:pass@apps.example',
      'https://apps.example/path',
      'https://apps.example?token=x',
      'https://apps.example#fragment',
    ])
      expect(() => loadConfig(write({ ...base(), publicUrl }))).toThrow(
        'HTTPS origin',
      );
    expect(
      loadConfig(write({ ...base(), publicUrl: 'http://127.0.0.1:8787' }))
        .publicUrl,
    ).toBe('http://127.0.0.1:8787');
  });

  it('loads only recognised secrets using an argument array and remembers the chosen config file', () => {
    const provider = JSON.stringify({
      encryptionKey: '11'.repeat(32),
      identities: { github: { botKey: '22'.repeat(32) } },
    });
    const path = write({
      ...base(),
      secretCommand: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(provider)})`,
      ],
    });
    const config = loadConfig(path);
    expect(config.encryptionKey).toBe('11'.repeat(32));
    expect(config.identities.github.botKey).toBe('22'.repeat(32));
    expect(sourceConfigPath(config)).toBe(path);
  });
  it('does not let a secret provider change routing and never includes provider output in failures', () => {
    let path = write({
      ...base(),
      secretCommand: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({host:"unexpected-host"}))',
      ],
    });
    expect(() => loadConfig(path)).toThrow('secret provider failed');
    path = write({
      ...base(),
      secretCommand: [
        process.execPath,
        '-e',
        'process.stderr.write("sensitive-provider-output");process.exit(1)',
      ],
    });
    try {
      loadConfig(path);
      throw new Error('Expected failure');
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-provider-output');
      expect(String(error)).toContain('secret provider failed');
    }
  });
  it('rejects relative credential writer paths', () => {
    expect(() =>
      loadConfig(
        write({ ...base(), githubCredentialsWriter: './store-secrets' }),
      ),
    ).toThrow('absolute');
  });
});
