import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';
const paths: string[] = [];
const stores: Store[] = [];
function open(path = mkdtempSync(join(tmpdir(), 'buzz-apps-test-'))) {
  if (!paths.includes(path)) paths.push(path);
  const s = new Store(path, '11'.repeat(32));
  stores.push(s);
  return { s, path };
}
afterEach(() => {
  for (const s of stores.splice(0)) if (s.db.open) s.close();
  for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true });
});
describe('durable state', () => {
  it('deduplicates accepted deliveries even after completion and restart', () => {
    const { s, path } = open();
    s.enqueue('hooks', 'delivery', { value: 1 });
    const job = s.take('hooks')!;
    s.complete(job);
    s.close();
    const next = open(path).s;
    next.enqueue('hooks', 'delivery', { value: 2 });
    expect(next.take('hooks')).toBeUndefined();
  });
  it('recovers work interrupted during processing', () => {
    const { s, path } = open();
    s.enqueue('hooks', 'delivery', { value: 1 });
    expect(s.take('hooks')?.attempts).toBe(1);
    s.close();
    const job = open(path).s.take('hooks');
    expect(job?.attempts).toBe(2);
    expect(job?.payload).toEqual({ value: 1 });
  });
  it('rolls back related records together', () => {
    const { s } = open();
    expect(() =>
      s.transaction(() => {
        s.set('x', 'a', 1);
        throw new Error('interrupted');
      }),
    ).toThrow();
    expect(s.get('x', 'a')).toBeUndefined();
  });
  it('encrypts linked account tokens on disk and rejects the wrong key', () => {
    const { s, path } = open();
    s.saveAccount({
      pubkey: 'person',
      login: 'test',
      token: 'very-secret-access-token',
    });
    expect(s.account('person')?.token).toBe('very-secret-access-token');
    s.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(
      readFileSync(join(path, 'state.sqlite')).includes(
        'very-secret-access-token',
      ),
    ).toBe(false);
    s.close();
    const wrong = new Store(path, '22'.repeat(32));
    stores.push(wrong);
    expect(() => wrong.account('person')).toThrow();
  });
  it('retains terminal failures without silently retrying', () => {
    const { s } = open();
    s.enqueue('hooks', 'x', {});
    const job = s.take('hooks')!;
    s.fail(job, 'rejected');
    expect(s.take('hooks')).toBeUndefined();
    expect(s.counts()).toEqual({ failed: 1 });
  });
});
