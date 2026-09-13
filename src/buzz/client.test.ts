import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeEvent,
  getPublicKey,
  nip19,
  verifyEvent,
  type Event,
} from 'nostr-tools';
import { Store } from '../core/store.js';
import type { Config } from '../core/types.js';
import { BuzzClient, decodeBotKey, isMention, toMessage } from './client.js';

const sockets = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    constructor() {
      super();
      sockets.items.push(this);
    }
    send(value: string) {
      this.sent.push(value);
    }
    close() {
      this.emit('close');
    }
    terminate() {
      this.emit('close');
    }
  },
}));

const key = Uint8Array.from(Buffer.from('01'.repeat(32), 'hex'));
const humanKey = Uint8Array.from(Buffer.from('02'.repeat(32), 'hex'));
const relayKey = Uint8Array.from(Buffer.from('03'.repeat(32), 'hex'));
const human = getPublicKey(humanKey);
const relay = getPublicKey(relayKey);
const seconds = () => Math.floor(Date.now() / 1000);
const message = (content: string, at = seconds(), tags = [['h', 'room']]) =>
  finalizeEvent({ kind: 9, content, tags, created_at: at }, humanKey);
const discovery = (kind: number, tags: string[][], signingKey = relayKey) =>
  finalizeEvent({ kind, tags, content: '', created_at: seconds() }, signingKey);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let directory: string;
let existingProfile = true;
let store: Store;
let config: Config;
let client: BuzzClient;
let requests: { path: string; body: unknown; auth: Event }[];
let queryHandler: (
  filters: Record<string, unknown>[],
) => Event[] | Promise<Event[]>;
let publishHandler: (
  event: Event,
) =>
  | { accepted: boolean; event_id: string; message?: string }
  | Promise<{ accepted: boolean; event_id: string; message?: string }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
  sockets.items = [];
  existingProfile = true;
  directory = mkdtempSync(join(tmpdir(), 'buzz-transport-test-'));
  config = {
    identities: { github: { botKey: Buffer.from(key).toString('hex') } },
    relayUrl: 'https://relay.example',
    encryptionKey: '04'.repeat(32),
    dataDir: directory,
    publicUrl: 'https://apps.example',
    host: '127.0.0.1',
    port: 3000,
    enabledApps: ['github'],
    admins: [],
  } as Config;
  store = new Store(directory, config.encryptionKey);
  client = new BuzzClient(config, store, log);
  requests = [];
  queryHandler = () => [];
  publishHandler = (event) => ({ accepted: true, event_id: event.id });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/info') return Response.json({ self: relay });
      const headers = options!.headers as Record<string, string>;
      const auth = JSON.parse(
        Buffer.from(headers.authorization.slice(6), 'base64').toString(),
      ) as Event;
      const encoded = options!.body as string;
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.kind).toBe(27235);
      expect(auth.tags).toContainEqual(['u', url]);
      expect(auth.tags).toContainEqual(['method', 'POST']);
      expect(auth.tags).toContainEqual([
        'payload',
        createHash('sha256').update(encoded).digest('hex'),
      ]);
      const body: unknown = JSON.parse(encoded);
      requests.push({ path, body, auth });
      if (path === '/query')
        return Response.json(
          (body as { kinds?: number[] }[])[0].kinds?.[0] === 0
            ? existingProfile
              ? [
                  finalizeEvent(
                    {
                      kind: 0,
                      content: '{"name":"existing"}',
                      tags: [],
                      created_at: seconds(),
                    },
                    key,
                  ),
                ]
              : []
            : await queryHandler(body as Record<string, unknown>[]),
        );
      if (path === '/events')
        return Response.json(await publishHandler(body as Event));
      throw new Error('Unexpected endpoint');
    }),
  );
});
afterEach(async () => {
  await client.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Buzz signed delivery', () => {
  it('deduplicates logical sends after confirmed delivery and isolates app identities', async () => {
    const first = await client.send('room', 'Parent notification', {
      dedupKey: 'delivery:123',
    });
    await client.flush();
    expect(
      await client.send('room', 'Parent notification', {
        dedupKey: 'delivery:123',
      }),
    ).toBe(first);
    expect(store.list(`${client.storagePrefix}.outbox`)).toHaveLength(0);
    const secondApp = new BuzzClient(
      {
        ...config,
        identities: {
          ...config.identities,
          calendar: { botKey: Buffer.from(humanKey).toString('hex') },
        },
      },
      store,
      log,
      'calendar',
    );
    const second = await secondApp.send('room', 'Parent notification', {
      dedupKey: 'delivery:123',
    });
    expect(second).not.toBe(first);
    expect(secondApp.status().pending).toBe(1);
    expect(client.status().pending).toBe(0);
    await secondApp.close();
    const anotherChannel = await client.send(
      'another-room',
      'Parent notification',
      { dedupKey: 'delivery:123' },
    );
    expect(anotherChannel).not.toBe(first);
  });

  it('preserves exact event bytes across a lost acknowledgement and a service restart', async () => {
    const id = await client.send('room', 'A private notification');
    let attempts = 0;
    publishHandler = (event) => {
      if (++attempts === 1) throw new Error('connection dropped after storage');
      return {
        accepted: true,
        event_id: event.id,
        message: 'duplicate: already stored',
      };
    };
    await client.flush();
    expect(store.list(`${client.storagePrefix}.outbox`)).toHaveLength(1);
    await client.close();
    store.close();
    store = new Store(directory, config.encryptionKey);
    client = new BuzzClient(config, store, log);
    vi.setSystemTime(Date.now() + 5_000);
    await client.flush();
    const attemptsSent = requests.filter((item) => item.path === '/events');
    expect(attemptsSent).toHaveLength(2);
    expect(attemptsSent[0].body).toEqual(attemptsSent[1].body);
    expect((attemptsSent[0].body as Event).id).toBe(id);
    expect(attemptsSent[0].auth.id).not.toBe(attemptsSent[1].auth.id);
    expect(store.list(`${client.storagePrefix}.outbox`)).toHaveLength(0);
  });

  it('holds replies and edits until their parent is confirmed, preserving enqueue order', async () => {
    const parent = await client.send('room', 'Parent');
    const reply = await client.send('room', 'Reply', {
      root: parent,
      broadcast: true,
    });
    const edit = await client.send('room', 'Updated parent', { edit: parent });
    publishHandler = () => {
      throw new Error('temporary failure');
    };
    await client.flush();
    expect(requests.filter((item) => item.path === '/events')).toHaveLength(1);
    publishHandler = (event) => ({ accepted: true, event_id: event.id });
    vi.setSystemTime(Date.now() + 5_000);
    await client.flush();
    expect(
      requests
        .filter((item) => item.path === '/events')
        .map((item) => (item.body as Event).id),
    ).toEqual([parent, parent, reply, edit]);
    const events = requests
      .filter((item) => item.path === '/events')
      .map((item) => item.body as Event);
    expect(events[2].tags).toContainEqual(['e', parent, '', 'reply']);
    expect(events[2].tags).toContainEqual(['broadcast', '1']);
    expect(events[3].kind).toBe(40003);
    expect(events[3].tags).toContainEqual(['e', parent]);
  });

  it('reconciles expired signed events and never re-signs uncertain writes', async () => {
    const id = await client.send('room', 'Expired notification');
    const persisted = store.get<{ event: Event }>(
      `${client.storagePrefix}.outbox`,
      id,
    )!.event;
    vi.setSystemTime(Date.now() + 16 * 60_000);
    queryHandler = () => [persisted];
    await client.flush();
    expect(store.list(`${client.storagePrefix}.outbox`)).toHaveLength(0);
    expect(requests.filter((item) => item.path === '/events')).toHaveLength(0);
    const absentId = await client.send('room', 'Never delivered');
    vi.setSystemTime(Date.now() + 16 * 60_000);
    queryHandler = () => [];
    await client.flush();
    expect(
      store.get<{ failed: string }>(`${client.storagePrefix}.outbox`, absentId)
        ?.failed,
    ).toContain('operator review');
    expect(requests.filter((item) => item.path === '/events')).toHaveLength(0);
  });

  it('distinguishes intentional identical messages and validates message bounds', async () => {
    expect(await client.send('room', 'Same')).not.toBe(
      await client.send('room', 'Same'),
    );
    await expect(client.send('room', 'x'.repeat(65_537))).rejects.toThrow(
      '64 KiB',
    );
    await expect(
      client.send('room', 'Hello', { mentions: ['invalid'] }),
    ).rejects.toThrow('mentions');
  });
});

describe('Buzz incoming history', () => {
  it('advertises command eligibility for Desktop without claiming channel membership', async () => {
    await client.start(async () => {});
    const events = requests
      .filter((r) => r.path === '/events')
      .map((r) => r.body as Event)
      .filter((e) => e.kind === 10100);
    expect(events).toHaveLength(1);
    expect(verifyEvent(events[0])).toBe(true);
    expect(JSON.parse(events[0].content)).toMatchObject({
      name: 'GitHub',
      respond_to: 'anyone',
    });
    expect(JSON.parse(events[0].content)).not.toHaveProperty('channel_ids');
    await client.close();
    client = new BuzzClient(config, store, log);
    queryHandler = (filters) =>
      filters.some((f) => (f.kinds as number[])?.includes(10100)) ? events : [];
    requests = [];
    await client.start(async () => {});
    expect(
      requests.filter(
        (r) => r.path === '/events' && (r.body as Event).kind === 10100,
      ),
    ).toHaveLength(0);
  });

  it('provisions a new GitHub profile once and preserves an existing identity profile', async () => {
    existingProfile = false;
    await client.start(async () => {});
    const profiles = requests.filter(
      (row) => row.path === '/events' && (row.body as Event).kind === 0,
    );
    expect(profiles).toHaveLength(1);
    expect(JSON.parse((profiles[0].body as Event).content)).toMatchObject({
      display_name: 'GitHub',
      name: 'github',
    });
    await client.close();
    client = new BuzzClient(config, store, log);
    existingProfile = true;
    await client.start(async () => {});
    expect(
      requests.filter(
        (row) => row.path === '/events' && (row.body as Event).kind === 0,
      ),
    ).toHaveLength(1);
  });

  it('skips history on first installation and ignores self echoes and duplicate events', async () => {
    const old = message('old command', seconds() - 1);
    const current = message('new command');
    const self = finalizeEvent(
      {
        kind: 9,
        created_at: seconds(),
        content: 'self',
        tags: [['h', 'room']],
      },
      key,
    );
    queryHandler = () => [old, current, current, self];
    const callback = vi.fn(async () => {});
    await client.start(callback);
    expect(
      callback.mock.calls.map((call) => (call[0] as { id: string }).id),
    ).toEqual([current.id]);
    vi.setSystemTime(Date.now() + 6_000);
    await client.flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('uses the composite cursor and advances its watermark only after every page persists', async () => {
    const start = seconds();
    store.set(`${client.storagePrefix}.state`, 'started', start - 30);
    store.set(`${client.storagePrefix}.state`, 'watermark', start - 20);
    const page = Array.from({ length: 500 }, (_, index) =>
      message(String(index), start - 1),
    );
    const older = message('older', start - 2);
    let failed = false;
    queryHandler = (filters) => {
      if (!filters[0].before_id) return page;
      expect(filters[0].before_id).toBe(page.at(-1)!.id);
      expect(filters[0].until).toBe(start - 1);
      if (!failed) {
        failed = true;
        throw new Error('page two network failure');
      }
      return [older];
    };
    const callback = vi.fn(async () => {});
    await client.start(callback);
    expect(callback).not.toHaveBeenCalled();
    expect(store.get(`${client.storagePrefix}.state`, 'watermark')).toBe(
      start - 20,
    );
    await client.flush();
    expect(callback).toHaveBeenCalledTimes(501);
    expect(store.get(`${client.storagePrefix}.state`, 'watermark')).toBe(start);
    expect((callback.mock.calls[0][0] as { id: string }).id).toBe(older.id);
  });

  it('retries a failed callback from durable inbox after restart', async () => {
    const incoming = message('help');
    queryHandler = () => [incoming];
    await client.start(async () => {
      throw new Error('handler unavailable');
    });
    expect(store.list(`${client.storagePrefix}.inbox`)).toHaveLength(1);
    await client.close();
    store.close();
    store = new Store(directory, config.encryptionKey);
    client = new BuzzClient(config, store, log);
    vi.setSystemTime(Date.now() + 5_000);
    const callback = vi.fn(async () => {});
    await client.start(callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(store.list(`${client.storagePrefix}.inbox`)).toHaveLength(0);
  });

  it('authenticates the websocket, discovers member channels, and validates signatures', async () => {
    const member = discovery(39002, [
      ['d', 'room'],
      ['p', client.pubkey],
    ]);
    queryHandler = (filters) =>
      filters[0].kinds?.toString() === '39002' ? [member] : [];
    const callback = vi.fn(async () => {});
    await client.start(callback);
    const socket = sockets.items[0] as EventEmitter & { sent: string[] };
    socket.emit(
      'message',
      Buffer.from(JSON.stringify(['AUTH', 'test-challenge'])),
    );
    const auth = JSON.parse(socket.sent[0]) as [string, Event];
    expect(auth[0]).toBe('AUTH');
    expect(verifyEvent(auth[1])).toBe(true);
    expect(auth[1].kind).toBe(22242);
    expect(auth[1].tags).toContainEqual(['challenge', 'test-challenge']);
    socket.emit(
      'message',
      Buffer.from(JSON.stringify(['OK', auth[1].id, true, ''])),
    );
    await client.flush();
    expect(socket.sent.map((item) => JSON.parse(item))).toContainEqual([
      'REQ',
      'buzz-apps',
      { kinds: [9], '#h': ['room'], since: seconds(), limit: 0 },
    ]);
    const incoming = message('hello');
    socket.emit(
      'message',
      Buffer.from(JSON.stringify(['EVENT', 'buzz-apps', incoming])),
    );
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify([
          'EVENT',
          'buzz-apps',
          { ...incoming, content: 'forged' },
        ]),
      ),
    );
    await client.flush();
    expect(callback).toHaveBeenCalledTimes(1);
    expect((callback.mock.calls[0][0] as { content: string }).content).toBe(
      'hello',
    );
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((frame) => frame[0] === 'CLOSE'),
    ).toHaveLength(0);
    queryHandler = () => [];
    vi.setSystemTime(Date.now() + 31_000);
    await client.flush();
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((frame) => frame[0] === 'CLOSE'),
    ).toHaveLength(1);
    socket.emit(
      'message',
      Buffer.from(JSON.stringify(['CLOSED', 'buzz-apps', ''])),
    );
    expect(client.status().connected).toBe(true);
  });
});

describe('Buzz authority and direct messages', () => {
  it('accepts only relay-signed owner/admin membership or explicit operator configuration', async () => {
    const tags = [
      ['d', 'room'],
      ['p', human, 'admin'],
    ];
    queryHandler = () => [discovery(39001, tags, humanKey)];
    expect(await client.canManage('room', human)).toBe(false);
    queryHandler = () => [discovery(39001, tags)];
    expect(await client.canManage('room', human)).toBe(true);
    queryHandler = () => [
      discovery(39001, [
        ['d', 'room'],
        ['p', human, 'member'],
      ]),
    ];
    expect(await client.canManage('room', human)).toBe(false);
    config.admins.push(human);
    expect(await client.canManage('room', human)).toBe(true);
  });

  it('recovers the canonical DM after a lost ACK and does not reuse a group DM', async () => {
    const group = discovery(39000, [
      ['d', 'group'],
      ['t', 'dm'],
      ['p', client.pubkey],
      ['p', human],
      ['p', relay],
    ]);
    const direct = discovery(39000, [
      ['d', 'direct'],
      ['t', 'dm'],
      ['p', client.pubkey],
      ['p', human],
    ]);
    let discovered = false;
    queryHandler = () => (discovered ? [group, direct] : [group]);
    let attempts = 0;
    publishHandler = (event) => {
      if (++attempts === 1) throw new Error('lost acknowledgment');
      discovered = true;
      return {
        accepted: true,
        event_id: event.id,
        message: 'duplicate: already processed',
      };
    };
    await expect(client.dm(human, 'Private content')).rejects.toThrow(
      'lost acknowledgment',
    );
    await client.dm(human, 'Private content');
    const sent = requests
      .filter((item) => item.path === '/events')
      .map((item) => item.body as Event);
    expect(sent).toHaveLength(2);
    expect(sent[0].kind).toBe(41010);
    expect(sent[0]).toEqual(sent[1]);
    const pending = store.list<{ event: Event }>(
      `${client.storagePrefix}.outbox`,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].value.event.tags).toContainEqual(['h', 'direct']);
  });

  it('maps threads and requires a signed mention tag, not display text', () => {
    const bare = toMessage(message('@GitHub help'))!;
    expect(isMention(bare, client.pubkey)).toBe(false);
    const nested = toMessage(
      message('@GitHub help', seconds(), [
        ['h', 'room'],
        ['p', client.pubkey],
        ['e', 'root', '', 'root'],
        ['e', 'parent', '', 'reply'],
      ]),
    )!;
    expect(isMention(nested, client.pubkey)).toBe(true);
    expect(nested.root).toBe('root');
    expect(decodeBotKey(nip19.nsecEncode(key))).toEqual(key);
    expect(() => decodeBotKey(nip19.npubEncode(human))).toThrow('private');
  });
});
