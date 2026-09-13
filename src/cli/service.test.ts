import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<object>()),
  homedir: () => state.home,
}));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
}));
import { installService, serviceFile } from './service.js';

afterEach(() => {
  rmSync(state.home, { recursive: true, force: true });
  delete process.env.BUZZ_APPS_INSTALL_DIR;
});
describe('native service installation', () => {
  it('stores a custom label and uses the installed package and external config paths', () => {
    state.home = mkdtempSync(join(tmpdir(), 'buzz-apps-service-'));
    process.env.BUZZ_APPS_INSTALL_DIR = join(state.home, 'runtime');
    const entrypoint = join(
      state.home,
      'npm prefix/lib/node_modules/buzz-apps/dist/src/cli/main.js',
    );
    mkdirSync(join(entrypoint, '..'), { recursive: true });
    writeFileSync(entrypoint, '// fixture');
    const config = join(state.home, 'private/config.json');
    installService(config, entrypoint, 'org.example.buzz-github');
    const file = serviceFile();
    const content = readFileSync(file, 'utf8');
    expect(file).toContain('org.example.buzz-github');
    expect(content).toContain(entrypoint);
    expect(content).toContain(config);
    expect(content).toContain(process.execPath);
    expect(content).not.toContain('current/dist');
    expect(
      JSON.parse(readFileSync(join(state.home, 'runtime/service.json'), 'utf8'))
        .label,
    ).toBe('org.example.buzz-github');
    expect(() =>
      installService(config, entrypoint, 'org.other.service'),
    ).toThrow('different label');
  });
});
