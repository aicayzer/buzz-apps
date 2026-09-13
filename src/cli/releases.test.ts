import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBackup,
  restoreBackup,
  restoreInstalled,
  replaceInstalled,
  validateVersion,
} from './releases.js';
import type { Config } from '../core/types.js';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
  delete process.env.BUZZ_APPS_INSTALL_DIR;
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'buzz-apps-update-'));
  temporary.push(root);
  process.env.BUZZ_APPS_INSTALL_DIR = root;
  const packageDir = join(root, 'installed');
  const dataDir = join(root, 'data');
  const configPath = join(root, 'config.json');
  mkdirSync(packageDir);
  mkdirSync(dataDir);
  writeFileSync(join(packageDir, 'version'), 'old');
  writeFileSync(join(dataDir, 'database'), 'old-data');
  writeFileSync(configPath, 'old-config');
  const config = { dataDir, host: '127.0.0.1', port: 8080 } as Config;
  return { root, packageDir, dataDir, configPath, config };
}
describe('paired npm updates', () => {
  it('recreates the npm executable when a failed install removed it', async () => {
    const f = fixture();
    const binPath = join(f.root, 'bin/buzz-apps');
    const cli = join(f.packageDir, 'dist/src/cli/main.js');
    mkdirSync(join(cli, '..'), { recursive: true });
    mkdirSync(join(binPath, '..'), { recursive: true });
    writeFileSync(cli, '// old executable');
    symlinkSync(cli, binPath);
    await expect(
      replaceInstalled(f.config, f.configPath, f.packageDir, {
        binPath,
        stop() {},
        start() {},
        async verify() {},
        install() {
          rmSync(binPath);
          rmSync(f.packageDir, { recursive: true });
          throw new Error('npm failed');
        },
      }),
    ).rejects.toThrow('restored');
    expect(readlinkSync(binPath)).toBe(cli);
    expect(readFileSync(cli, 'utf8')).toBe('// old executable');
  });
  it('refuses an incomplete rollback before stopping the running service', async () => {
    const f = fixture();
    const backup = createBackup(f.packageDir, f.config, f.configPath);
    rmSync(backup.packageBackup, { recursive: true });
    let stopped = false;
    await expect(
      restoreInstalled(backup, {
        stop() {
          stopped = true;
        },
        start() {},
        async verify() {},
      }),
    ).rejects.toThrow('incomplete');
    expect(stopped).toBe(false);
  });

  it('a failed new health check restores the backup made for that update', async () => {
    const f = fixture();
    createBackup(f.packageDir, f.config, f.configPath);
    writeFileSync(join(f.packageDir, 'version'), 'current');
    writeFileSync(join(f.dataDir, 'database'), 'current-data');
    let verifications = 0;
    await expect(
      replaceInstalled(f.config, f.configPath, f.packageDir, {
        stop() {},
        start() {},
        install() {
          writeFileSync(join(f.packageDir, 'version'), 'broken');
          writeFileSync(join(f.dataDir, 'database'), 'broken-data');
        },
        async verify() {
          if (++verifications === 1) throw new Error('unhealthy');
        },
      }),
    ).rejects.toThrow('matching package');
    expect(readFileSync(join(f.packageDir, 'version'), 'utf8')).toBe('current');
    expect(readFileSync(join(f.dataDir, 'database'), 'utf8')).toBe(
      'current-data',
    );
  });
  it('a backup failure never restores an older rollback snapshot', async () => {
    const f = fixture();
    createBackup(f.packageDir, f.config, f.configPath);
    writeFileSync(join(f.dataDir, 'database'), 'current-data');
    let installed = false;
    await expect(
      replaceInstalled(f.config, join(f.root, 'missing-config'), f.packageDir, {
        stop() {},
        start() {},
        install() {
          installed = true;
        },
        async verify() {},
      }),
    ).rejects.toThrow('backup failed');
    expect(installed).toBe(false);
    expect(readFileSync(join(f.dataDir, 'database'), 'utf8')).toBe(
      'current-data',
    );
  });

  it('refuses incomplete rollback before changing the installed package or data', () => {
    const f = fixture();
    const backup = createBackup(f.packageDir, f.config, f.configPath);
    rmSync(backup.packageBackup, { recursive: true });
    expect(() => restoreBackup(backup)).toThrow('incomplete');
    expect(readFileSync(join(f.packageDir, 'version'), 'utf8')).toBe('old');
    expect(readFileSync(join(f.dataDir, 'database'), 'utf8')).toBe('old-data');
  });

  it('restores the matching package, data and configuration without merging generations', () => {
    const f = fixture();
    const backup = createBackup(f.packageDir, f.config, f.configPath);
    writeFileSync(join(f.packageDir, 'version'), 'new');
    writeFileSync(join(f.dataDir, 'database'), 'new-data');
    writeFileSync(join(f.dataDir, 'new-only'), 'schema');
    writeFileSync(f.configPath, 'new-config');
    restoreBackup(backup);
    expect(readFileSync(join(f.packageDir, 'version'), 'utf8')).toBe('old');
    expect(readFileSync(join(f.dataDir, 'database'), 'utf8')).toBe('old-data');
    expect(readFileSync(f.configPath, 'utf8')).toBe('old-config');
    expect(existsSync(join(f.dataDir, 'new-only'))).toBe(false);
  });
  it('a failed new backup leaves the previous rollback pointer untouched', () => {
    const f = fixture();
    createBackup(f.packageDir, f.config, f.configPath);
    const previous = readFileSync(join(f.root, 'rollback.json'), 'utf8');
    expect(() =>
      createBackup(f.packageDir, f.config, join(f.root, 'missing-config')),
    ).toThrow();
    expect(readFileSync(join(f.root, 'rollback.json'), 'utf8')).toBe(previous);
    expect(readFileSync(join(f.dataDir, 'database'), 'utf8')).toBe('old-data');
  });
  it('rejects package specifiers and command fragments as release versions', () => {
    expect(validateVersion('v0.1.0-rc.1')).toBe('0.1.0-rc.1');
    for (const value of [
      'latest',
      'https://example.org/a.tgz',
      '../package',
      '1.0.0 --prefix /tmp',
    ])
      expect(() => validateVersion(value)).toThrow();
  });
});
