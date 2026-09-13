import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, StoreApi } from './types.js';

export interface Job {
  queue: string;
  id: string;
  payload: unknown;
  attempts: number;
}
export class Store implements StoreApi {
  readonly db: Database.Database;
  private readonly key: Buffer;
  constructor(dataDir: string, encryptionKey: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.key = Buffer.from(encryptionKey, 'hex');
    if (this.key.length !== 32) throw new Error('Invalid encryption key');
    const path = join(dataDir, 'state.sqlite');
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1)
      throw new Error(
        'Database is newer than this release; restore its matching backup',
      );
    this.db.transaction(() => {
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS kv(space TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(space,key));
        CREATE TABLE IF NOT EXISTS jobs(queue TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',error TEXT,PRIMARY KEY(queue,id));
        CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,at); PRAGMA user_version=1;`);
    })();
    this.db
      .prepare("UPDATE jobs SET state='pending' WHERE state='running'")
      .run();
  }
  get<T>(space: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM kv WHERE space=? AND key=?')
      .get(space, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(space: string, key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO kv VALUES (?,?,?) ON CONFLICT(space,key) DO UPDATE SET value=excluded.value',
      )
      .run(space, key, JSON.stringify(value));
  }
  delete(space: string, key: string): void {
    this.db.prepare('DELETE FROM kv WHERE space=? AND key=?').run(space, key);
  }
  list<T>(space: string): { key: string; value: T }[] {
    return (
      this.db
        .prepare('SELECT key,value FROM kv WHERE space=? ORDER BY key')
        .all(space) as { key: string; value: string }[]
    ).map((x) => ({ key: x.key, value: JSON.parse(x.value) }));
  }
  once(space: string, key: string, value: unknown = true): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO kv VALUES (?,?,?)')
        .run(space, key, JSON.stringify(value)).changes === 1
    );
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  enqueue(queue: string, id: string, payload: unknown, at = Date.now()): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO jobs(queue,id,payload,at) VALUES(?,?,?,?)',
      )
      .run(queue, id, JSON.stringify(payload), at);
  }
  take(queue: string): Job | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM jobs WHERE queue=? AND state='pending' AND at<=? ORDER BY at,id LIMIT 1",
        )
        .get(queue, Date.now()) as
        | { queue: string; id: string; payload: string; attempts: number }
        | undefined;
      if (!row) return;
      this.db
        .prepare(
          "UPDATE jobs SET state='running',attempts=attempts+1 WHERE queue=? AND id=?",
        )
        .run(queue, row.id);
      return {
        ...row,
        payload: JSON.parse(row.payload),
        attempts: row.attempts + 1,
      };
    });
  }
  complete(job: Job): void {
    this.db
      .prepare(
        "UPDATE jobs SET state='done',payload='null',error=NULL WHERE queue=? AND id=?",
      )
      .run(job.queue, job.id);
  }
  fail(job: Job, error: string, retryMs?: number): void {
    this.db
      .prepare('UPDATE jobs SET state=?,at=?,error=? WHERE queue=? AND id=?')
      .run(
        retryMs === undefined ? 'failed' : 'pending',
        Date.now() + (retryMs ?? 0),
        error,
        job.queue,
        job.id,
      );
  }
  counts(): Record<string, number> {
    return Object.fromEntries(
      (
        this.db
          .prepare('SELECT state,COUNT(*) AS n FROM jobs GROUP BY state')
          .all() as { state: string; n: number }[]
      ).map((x) => [x.state, x.n]),
    );
  }
  private seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    );
  }
  private open<T>(value: string): T {
    const b = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(
        'utf8',
      ),
    );
  }
  secret<T>(space: string, key: string): T | undefined {
    const value = this.get<string>(space, key);
    return value ? this.open<T>(value) : undefined;
  }
  saveSecret(space: string, key: string, value: unknown): void {
    this.set(space, key, this.seal(value));
  }
  account(pubkey: string): Account | undefined {
    const value = this.get<string>('accounts', pubkey);
    return value ? this.open<Account>(value) : undefined;
  }
  saveAccount(account: Account): void {
    this.set('accounts', account.pubkey, this.seal(account));
  }
  removeAccount(pubkey: string): void {
    this.delete('accounts', pubkey);
  }
  close(): void {
    this.db.close();
  }
}
