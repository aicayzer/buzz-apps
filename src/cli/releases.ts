import {
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { lock } from 'proper-lockfile';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  installationRoot,
  controlService,
  serviceInstalled,
} from './service.js';
import type { Config } from '../core/types.js';

interface Backup {
  packageBackup: string;
  packageDir: string;
  dataBackup: string;
  dataDir: string;
  configBackup: string;
  configPath: string;
  host: string;
  port: number;
  binPath?: string;
  wasReady?: boolean;
}
export function npmInstallation(): { prefix: string; packageDir: string } {
  const prefix = execFileSync('npm', ['prefix', '--global'], {
    encoding: 'utf8',
  }).trim();
  const npmRoot = execFileSync(
    'npm',
    ['root', '--global', '--prefix', prefix],
    { encoding: 'utf8' },
  ).trim();
  const packageDir = join(npmRoot, 'buzz-apps');
  const running = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  if (
    !existsSync(packageDir) ||
    realpathSync(packageDir) !== realpathSync(running)
  )
    throw new Error(
      'This command requires the global npm installation in the current npm prefix. For Docker or development checkouts, follow the documented update procedure.',
    );
  return { prefix, packageDir };
}
export function validateVersion(value: string): string {
  const version = value.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error('Version must be explicit, for example 0.1.0-rc.1.');
  return version;
}
async function ready(host: string, port: number): Promise<boolean> {
  const address = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  try {
    return (
      await fetch(`http://${address}:${port}/ready`, {
        signal: AbortSignal.timeout(2000),
      })
    ).ok;
  } catch {
    return false;
  }
}
async function healthy(
  host: string,
  port: number,
  requireReady = false,
): Promise<void> {
  const address = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(
        `http://${address}:${port}/${requireReady ? 'ready' : 'health'}`,
        {
          signal: AbortSignal.timeout(2000),
        },
      );
      if (response.ok && ((await response.json()) as { ok?: boolean }).ok)
        return;
    } catch {
      /* Startup is allowed to be briefly unavailable. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Service failed its health check.');
}
export function createBackup(
  packageDir: string,
  config: Config,
  configPath: string,
  binPath?: string,
  wasReady?: boolean,
): Backup {
  const backupDir = join(
    installationRoot(),
    'backups',
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID(),
  );
  if (
    backupDir.startsWith(resolve(config.dataDir) + sep) ||
    backupDir.startsWith(resolve(packageDir) + sep)
  )
    throw new Error(
      'Backups must live outside the package and data directories.',
    );
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup: Backup = {
    packageBackup: join(backupDir, 'package'),
    packageDir,
    dataBackup: join(backupDir, 'data'),
    dataDir: resolve(config.dataDir),
    configBackup: join(backupDir, 'config.json'),
    configPath: resolve(configPath),
    host: config.host,
    port: config.port,
    binPath,
    wasReady,
  };
  try {
    if (
      binPath &&
      existsSync(binPath) &&
      (!lstatSync(binPath).isSymbolicLink() ||
        resolve(dirname(binPath), readlinkSync(binPath)) !==
          join(packageDir, 'dist/src/cli/main.js'))
    )
      throw new Error(
        'The npm executable does not point to this installation.',
      );
    cpSync(packageDir, backup.packageBackup, {
      recursive: true,
      dereference: true,
    });
    if (existsSync(config.dataDir))
      cpSync(config.dataDir, backup.dataBackup, { recursive: true });
    else mkdirSync(backup.dataBackup);
    cpSync(configPath, backup.configBackup);
    // Only replace the previous rollback pointer after this complete backup exists.
    const manifest = join(installationRoot(), 'rollback.json');
    writeFileSync(manifest + '.next', JSON.stringify(backup), { mode: 0o600 });
    renameSync(manifest + '.next', manifest);
    return backup;
  } catch (error) {
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
}
export function validateBackup(backup: Backup): void {
  if (
    ![backup.packageBackup, backup.dataBackup, backup.configBackup].every(
      existsSync,
    )
  )
    throw new Error('The matching rollback backup is incomplete.');
  if (
    backup.binPath &&
    !existsSync(join(backup.packageBackup, 'dist/src/cli/main.js'))
  )
    throw new Error('The rollback package has no executable.');
}
export function restoreBackup(backup: Backup): void {
  validateBackup(backup);
  // Preserve the failed version and its data for diagnosis; never merge database generations.
  const suffix = '.before-rollback-' + Date.now();
  if (existsSync(backup.packageDir))
    renameSync(backup.packageDir, backup.packageDir + suffix);
  cpSync(backup.packageBackup, backup.packageDir, { recursive: true });
  if (existsSync(backup.dataDir))
    renameSync(backup.dataDir, backup.dataDir + suffix);
  cpSync(backup.dataBackup, backup.dataDir, { recursive: true });
  cpSync(backup.configBackup, backup.configPath);
  if (backup.binPath) {
    const temporary = backup.binPath + '.restore-' + randomUUID();
    mkdirSync(dirname(backup.binPath), { recursive: true });
    symlinkSync(join(backup.packageDir, 'dist/src/cli/main.js'), temporary);
    renameSync(temporary, backup.binPath);
  }
}
async function updateUnlocked(
  config: Config,
  configPath: string,
  requested?: string,
): Promise<string> {
  const { prefix, packageDir } = npmInstallation();
  if (!serviceInstalled())
    throw new Error(
      'Automatic update requires an installed native service so it can stop safely. See the documented procedure for foreground or Docker deployments.',
    );
  const version = validateVersion(
    requested ||
      execFileSync('npm', ['view', 'buzz-apps', 'version'], {
        encoding: 'utf8',
        timeout: 30_000,
      }).trim(),
  );
  const installedVersion = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ).version as string;
  if (installedVersion === version) return version;
  const wasReady = await ready(config.host, config.port);
  await replaceInstalled(config, configPath, packageDir, {
    binPath: join(prefix, 'bin', 'buzz-apps'),
    wasReady,
    stop: () => controlService('stop'),
    start: () => controlService('start'),
    verify: () => healthy(config.host, config.port, wasReady),
    install: () =>
      execFileSync(
        'npm',
        [
          'install',
          '--global',
          '--prefix',
          prefix,
          `buzz-apps@${version}`,
          '--no-audit',
          '--no-fund',
        ],
        { stdio: 'pipe', timeout: 300_000 },
      ),
  });
  return version;
}
export async function replaceInstalled(
  config: Config,
  configPath: string,
  packageDir: string,
  operations: {
    binPath?: string;
    wasReady?: boolean;
    stop(): void;
    start(): void;
    install(): void;
    verify(): Promise<void>;
  },
): Promise<void> {
  operations.stop();
  let backup: Backup | undefined;
  try {
    backup = createBackup(
      packageDir,
      config,
      configPath,
      operations.binPath,
      operations.wasReady,
    );
    operations.install();
    operations.start();
    await operations.verify();
  } catch (error) {
    if (backup) {
      operations.stop();
      restoreBackup(backup);
    }
    operations.start();
    await operations.verify();
    throw new Error(
      `Update failed; ${backup ? 'the matching package, configuration and data were restored' : 'the installation was not changed because backup failed'}. ${error instanceof Error ? error.message : ''}`,
      { cause: error },
    );
  }
}
async function rollbackUnlocked(config: Config): Promise<void> {
  const { packageDir } = npmInstallation();
  const file = join(installationRoot(), 'rollback.json');
  if (!existsSync(file))
    throw new Error('No matching package/data backup is available.');
  const backup = JSON.parse(readFileSync(file, 'utf8')) as Backup;
  if (
    resolve(config.dataDir) !== backup.dataDir ||
    packageDir !== backup.packageDir
  )
    throw new Error('Rollback backup does not match this installation.');
  await restoreInstalled(backup, {
    stop: () => controlService('stop'),
    start: () => controlService('start'),
    verify: () => healthy(backup.host, backup.port, backup.wasReady),
  });
}
export async function restoreInstalled(
  backup: Backup,
  operations: { stop(): void; start(): void; verify(): Promise<void> },
): Promise<void> {
  validateBackup(backup);
  operations.stop();
  restoreBackup(backup);
  operations.start();
  await operations.verify();
}

async function exclusively<T>(operation: () => Promise<T>): Promise<T> {
  const root = installationRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = await lock(root, {
    lockfilePath: join(root, 'update.lock'),
    retries: 0,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
export function updateRelease(
  config: Config,
  configPath: string,
  requested?: string,
): Promise<string> {
  return exclusively(() => updateUnlocked(config, configPath, requested));
}
export function rollbackRelease(config: Config): Promise<void> {
  return exclusively(() => rollbackUnlocked(config));
}
