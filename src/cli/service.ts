import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

function serviceLabel(): string {
  const file = join(installationRoot(), 'service.json');
  const label = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')).label
    : 'org.buzz-apps.service';
  if (typeof label !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label))
    throw new Error('Invalid service label.');
  return label;
}
function unitName(): string {
  const label = serviceLabel();
  return label.endsWith('.service') ? label : label + '.service';
}
export function installationRoot(): string {
  return (
    process.env.BUZZ_APPS_INSTALL_DIR ||
    join(homedir(), '.local/share/buzz-apps')
  );
}
function xml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[char]!,
  );
}
function unit(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/%/g, '%%')
      .replace(/\n/g, '') +
    '"'
  );
}
export function serviceFile(): string {
  if (process.platform === 'darwin')
    return join(homedir(), 'Library/LaunchAgents', serviceLabel() + '.plist');
  if (process.platform === 'linux')
    return join(homedir(), '.config/systemd/user', unitName());
  throw new Error(
    'Native services support macOS and Linux. Use Docker on other systems.',
  );
}
export function serviceInstalled(): boolean {
  return existsSync(serviceFile());
}
export function installService(
  configPath: string,
  entrypoint?: string,
  requestedLabel?: string,
): void {
  const entry =
    entrypoint || join(dirname(fileURLToPath(import.meta.url)), 'main.js');
  if (!existsSync(entry))
    throw new Error(
      'Install the npm package first, or pass --entrypoint with an absolute compiled CLI path.',
    );
  if (requestedLabel) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(requestedLabel))
      throw new Error('Invalid service label.');
    if (serviceInstalled() && serviceLabel() !== requestedLabel)
      throw new Error(
        'An existing service uses a different label. Remove its service file before changing the label.',
      );
    mkdirSync(installationRoot(), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(installationRoot(), 'service.json'),
      JSON.stringify({ label: requestedLabel }),
      { mode: 0o600 },
    );
  }
  const label = serviceLabel();
  const file = serviceFile();
  mkdirSync(dirname(file), { recursive: true });
  const logs = join(installationRoot(), 'logs');
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  if (process.platform === 'darwin') {
    const args = [
      process.execPath,
      resolve(entry),
      '--config',
      resolve(configPath),
      'start',
    ];
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(logs, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logs, 'service-error.log'))}</string></dict></plist>\n`,
      { mode: 0o600 },
    );
  } else {
    writeFileSync(
      file,
      `[Unit]\nDescription=Buzz Apps\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${[process.execPath, resolve(entry), '--config', resolve(configPath), 'start'].map(unit).join(' ')}\nRestart=on-failure\nRestartSec=10\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
      { mode: 0o600 },
    );
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  }
}
export function waitForUnload(
  loaded: () => boolean,
  pause: () => void = () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  },
): void {
  // bootout may acknowledge before launchd removes the registration. Starting
  // immediately can mistake that retiring job for an already-running service.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!loaded()) return;
    pause();
  }
  throw new Error(
    'The service is still unloading. Check launchd before starting or updating it.',
  );
}

export function controlService(action: 'start' | 'stop' | 'restart'): void {
  if (!serviceInstalled())
    throw new Error('Service is not installed. Run buzz-apps service install.');
  if (process.platform === 'darwin') {
    if (action === 'restart') {
      controlService('stop');
      controlService('start');
      return;
    }
    const domain = `gui/${process.getuid!()}`;
    const target = `${domain}/${serviceLabel()}`;
    let loaded = true;
    try {
      execFileSync('launchctl', ['print', target], { stdio: 'pipe' });
    } catch {
      loaded = false;
    }
    if (action === 'stop') {
      if (loaded) {
        execFileSync('launchctl', ['bootout', target], { stdio: 'pipe' });
        waitForUnload(() => {
          try {
            execFileSync('launchctl', ['print', target], { stdio: 'pipe' });
            return true;
          } catch {
            return false;
          }
        });
      }
    } else if (!loaded)
      execFileSync('launchctl', ['bootstrap', domain, serviceFile()], {
        stdio: 'pipe',
      });
  } else {
    if (action === 'start')
      execFileSync('systemctl', ['--user', 'enable', '--now', unitName()], {
        stdio: 'pipe',
      });
    else
      execFileSync('systemctl', ['--user', action, unitName()], {
        stdio: 'pipe',
      });
  }
}
