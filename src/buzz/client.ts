import { createHash, randomUUID } from 'node:crypto';
import {
  finalizeEvent,
  getPublicKey,
  nip19,
  verifyEvent,
  type Event,
} from 'nostr-tools';
import WebSocket from 'ws';
import type {
  AppContext,
  BuzzTransport,
  Config,
  Message,
  SendOptions,
  StoreApi,
} from '../core/types.js';

const PAGE_SIZE = 500;
const OVERLAP_SECONDS = 15 * 60;
const now = () => Math.floor(Date.now() / 1000);
const tag = (event: Event, name: string) =>
  event.tags.find((item) => item[0] === name)?.[1];
const isHexKey = (value: string) => /^[a-f0-9]{64}$/i.test(value);
interface Delivery {
  event: Event;
  attempts: number;
  next: number;
  order: number;
  failed?: string;
}
interface Inbox {
  event: Event;
  attempts: number;
  next: number;
}

export function decodeBotKey(value: string): Uint8Array {
  if (isHexKey(value)) return Uint8Array.from(Buffer.from(value, 'hex'));
  const decoded = nip19.decode(value);
  if (decoded.type !== 'nsec')
    throw new Error('Bot key must be a private hex key or nsec.');
  return decoded.data;
}

export function toMessage(event: Event): Message | undefined {
  const channel = tag(event, 'h');
  if (event.kind !== 9 || !channel) return undefined;
  const root =
    event.tags.find((item) => item[0] === 'e' && item[3] === 'root')?.[1] ??
    event.tags.find((item) => item[0] === 'e' && item[3] === 'reply')?.[1];
  return {
    id: event.id,
    channel,
    author: event.pubkey,
    content: event.content,
    tags: event.tags,
    createdAt: event.created_at,
    ...(root ? { root } : {}),
  };
}

export function isMention(message: Message, pubkey: string): boolean {
  return message.tags.some((item) => item[0] === 'p' && item[1] === pubkey);
}

class RelayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Buzz's signed HTTP bridge is the durable path; WebSocket events reduce latency. */
export class BuzzClient implements BuzzTransport {
  readonly pubkey: string;
  readonly storagePrefix: string;
  private readonly key: Uint8Array;
  private readonly httpUrl: string;
  private readonly wsUrl: string;
  private readonly authTag?: string[];
  private relayPubkey?: string;
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private connecting = false;
  private authenticated = false;
  private subscribed = false;
  private requestedCloses = 0;
  private backoff = 1_000;
  private lastChannels = 0;
  private lastCatchup = 0;
  private lastHttpSuccess = 0;
  private flushing?: Promise<void>;
  private onMessage?: (message: Message) => Promise<void>;
  private readonly dmRequests = new Map<string, Promise<string>>();

  constructor(
    private readonly config: Config,
    private readonly store: StoreApi,
    private readonly log: AppContext['log'],
    private readonly appId = 'github',
  ) {
    const identity = config.identities[appId];
    if (!identity) throw new Error(`No Buzz identity configured for ${appId}.`);
    this.key = decodeBotKey(identity.botKey);
    this.pubkey = getPublicKey(this.key);
    this.storagePrefix = `buzz.${appId}.${this.pubkey}`;
    const url = new URL(config.relayUrl);
    if (
      !['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        'Relay URL must be an HTTP or WebSocket URL without credentials.',
      );
    url.protocol = ['https:', 'wss:'].includes(url.protocol)
      ? 'https:'
      : 'http:';
    this.httpUrl = url.toString().replace(/\/$/, '');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.wsUrl = url.toString();
    if (identity.authTag) {
      const parsed: unknown = JSON.parse(identity.authTag);
      if (
        !Array.isArray(parsed) ||
        parsed[0] !== 'auth' ||
        !parsed.every((part) => typeof part === 'string')
      )
        throw new Error('Auth tag must be a JSON NIP-OA auth tag.');
      this.authTag = parsed;
    }
  }

  private sign(
    kind: number,
    content: string,
    tags: string[][],
    delegated = true,
  ): Event {
    return finalizeEvent(
      {
        kind,
        content,
        created_at: now(),
        tags: [...tags, ...(delegated && this.authTag ? [this.authTag] : [])],
      },
      this.key,
    );
  }

  private async request(path: string, body: unknown): Promise<unknown> {
    const url = `${this.httpUrl}${path}`;
    const encoded = JSON.stringify(body);
    const auth = this.sign(
      27235,
      '',
      [
        ['u', url],
        ['method', 'POST'],
        ['nonce', randomUUID()],
        ['payload', createHash('sha256').update(encoded).digest('hex')],
      ],
      false,
    );
    const response = await fetch(url, {
      method: 'POST',
      body: encoded,
      headers: {
        'content-type': 'application/json',
        authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`,
        ...(this.authTag ? { 'x-auth-tag': JSON.stringify(this.authTag) } : {}),
      },
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    // Relay error bodies can include submitted private content; never surface them in logs.
    if (!response.ok)
      throw new RelayError(
        `Buzz ${path} returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    const result: unknown = await response.json();
    this.lastHttpSuccess = Date.now();
    return result;
  }

  async query(filters: Record<string, unknown>[]): Promise<Event[]> {
    const result = await this.request('/query', filters);
    if (!Array.isArray(result))
      throw new Error('Buzz query returned an invalid response.');
    for (const event of result) {
      let valid = false;
      try {
        valid = verifyEvent(event as Event);
      } catch {
        /* Invalid relay data must not advance the history cursor. */
      }
      if (!valid)
        throw new Error('Buzz query returned an invalid event signature.');
    }
    return result as Event[];
  }

  private async pages(filter: Record<string, unknown>): Promise<Event[]> {
    const result: Event[] = [];
    let cursor: string | undefined;
    const current = { ...filter, limit: PAGE_SIZE };
    for (;;) {
      const page = await this.query([current]);
      result.push(...page);
      if (page.length < PAGE_SIZE) return result;
      const last = page.at(-1)!;
      const next = `${last.created_at}:${last.id}`;
      if (next === cursor)
        throw new Error('Buzz history cursor did not advance.');
      cursor = next;
      Object.assign(current, { until: last.created_at, before_id: last.id });
    }
  }

  private async ensureRelayIdentity(): Promise<string> {
    if (this.relayPubkey) return this.relayPubkey;
    const response = await fetch(`${this.httpUrl}/info`, {
      headers: { accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(
        `Buzz relay information returned HTTP ${response.status}.`,
      );
    const info = (await response.json()) as { self?: string };
    if (!info.self || !isHexKey(info.self))
      throw new Error(
        'Buzz relay must advertise its signing key in NIP-11 self.',
      );
    this.relayPubkey = info.self;
    return info.self;
  }

  async canManage(channel: string, pubkey: string): Promise<boolean> {
    if (this.config.admins.includes(pubkey)) return true;
    const relay = await this.ensureRelayIdentity();
    const events = await this.query([
      { kinds: [39001], authors: [relay], '#d': [channel], limit: 1 },
    ]);
    const latest = events
      .filter(
        (event) =>
          event.pubkey === relay &&
          event.kind === 39001 &&
          tag(event, 'd') === channel,
      )
      .sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      )[0];
    return (
      latest?.tags.some(
        (item) =>
          item[0] === 'p' &&
          item[1] === pubkey &&
          ['owner', 'admin'].includes(item[2]),
      ) ?? false
    );
  }

  async send(
    channel: string,
    content: string,
    options: SendOptions = {},
  ): Promise<string> {
    if (Buffer.byteLength(content, 'utf8') > 64 * 1024)
      throw new Error('Buzz message exceeds 64 KiB.');
    const logicalKey = options.dedupKey
      ? createHash('sha256')
          .update(JSON.stringify([channel, options.dedupKey]))
          .digest('hex')
      : undefined;
    const previous = logicalKey
      ? this.store.get<string>(`${this.storagePrefix}.logical`, logicalKey)
      : undefined;
    if (previous) return previous;
    const tags = [['h', channel]];
    if (options.edit) tags.push(['e', options.edit]);
    else if (options.root) tags.push(['e', options.root, '', 'reply']);
    if (options.broadcast && !options.edit) tags.push(['broadcast', '1']);
    const mentions = [...new Set(options.mentions ?? [])];
    if (mentions.length > 50 || mentions.some((key) => !isHexKey(key)))
      throw new Error('Invalid Buzz mentions.');
    tags.push(...mentions.map((key) => ['p', key]));
    // A nonce distinguishes two intentionally identical messages sent within one second.
    tags.push(['nonce', randomUUID()]);
    const event = this.sign(options.edit ? 40003 : 9, content, tags);
    this.store.transaction(() => {
      const order =
        (this.store.get<number>(
          `${this.storagePrefix}.state`,
          'outbox-order',
        ) ?? 0) + 1;
      this.store.set(`${this.storagePrefix}.state`, 'outbox-order', order);
      this.store.set(`${this.storagePrefix}.outbox`, event.id, {
        event,
        attempts: 0,
        next: 0,
        order,
      } satisfies Delivery);
      if (logicalKey)
        this.store.set(`${this.storagePrefix}.logical`, logicalKey, event.id);
    });
    return event.id;
  }

  async dm(
    pubkey: string,
    content: string,
    options: Pick<SendOptions, 'dedupKey'> = {},
  ): Promise<string> {
    if (!isHexKey(pubkey) || pubkey === this.pubkey)
      throw new Error('Invalid direct-message recipient.');
    let pending = this.dmRequests.get(pubkey);
    if (!pending) {
      pending = this.openDm(pubkey);
      this.dmRequests.set(pubkey, pending);
    }
    try {
      return await this.send(await pending, content, options);
    } finally {
      this.dmRequests.delete(pubkey);
    }
  }

  private async discoverDm(pubkey: string): Promise<string | undefined> {
    const relay = await this.ensureRelayIdentity();
    // Relay-signed discovery exposes the authoritative current participant set.
    const events = await this.pages({
      kinds: [39000],
      authors: [relay],
      '#p': [pubkey],
    });
    return events
      .find(
        (event) =>
          event.pubkey === relay &&
          tag(event, 't') === 'dm' &&
          event.tags.filter((item) => item[0] === 'p').length === 2 &&
          event.tags.some(
            (item) => item[0] === 'p' && item[1] === this.pubkey,
          ) &&
          event.tags.some((item) => item[0] === 'p' && item[1] === pubkey),
      )
      ?.tags.find((item) => item[0] === 'd')?.[1];
  }

  private async openDm(pubkey: string): Promise<string> {
    // Do not cache participant membership: a DM can become a group after creation.
    const existing = await this.discoverDm(pubkey);
    if (existing) return existing;
    let event = this.store.get<Event>(`${this.storagePrefix}.dm-open`, pubkey);
    if (!event) {
      event = this.sign(41010, '', [['p', pubkey]]);
      this.store.set(`${this.storagePrefix}.dm-open`, pubkey, event);
    }
    const result = await this.publish(event);
    let channel: string | undefined;
    if (result.message.startsWith('response:')) {
      const payload = JSON.parse(result.message.slice('response:'.length)) as {
        channel_id?: string;
      };
      channel = payload.channel_id;
    }
    // Duplicate acknowledgements omit the channel ID, including after a lost first ACK.
    channel ??= await this.discoverDm(pubkey);
    if (!channel)
      throw new Error(
        'Buzz accepted DM creation but its canonical channel is not visible yet.',
      );
    this.store.delete(`${this.storagePrefix}.dm-open`, pubkey);
    return channel;
  }

  private async publish(event: Event): Promise<{ message: string }> {
    // The relay rejects old timestamps. Never re-sign an uncertain message into a duplicate.
    if (event.created_at < now() - OVERLAP_SECONDS) {
      const found = await this.query([{ ids: [event.id], limit: 1 }]);
      if (found.some((item) => item.id === event.id))
        return { message: 'duplicate: already stored' };
      throw new RelayError(
        'Signed Buzz event expired before confirmed delivery; operator review required.',
        false,
      );
    }
    const result = (await this.request('/events', event)) as {
      accepted?: boolean;
      event_id?: string;
      message?: string;
    };
    if (!result.accepted || result.event_id !== event.id)
      throw new RelayError('Buzz rejected a signed event.', false);
    return { message: result.message ?? '' };
  }

  private async ensureProfile(): Promise<void> {
    if (this.appId !== 'github') return;
    const existing = await this.query([
      { kinds: [0], authors: [this.pubkey], limit: 1 },
    ]);
    if (
      existing.some((event) => event.kind === 0 && event.pubkey === this.pubkey)
    ) {
      this.store.delete(`${this.storagePrefix}.profile`, 'pending');
      return;
    }
    let event = this.store.get<Event>(
      `${this.storagePrefix}.profile`,
      'pending',
    );
    if (!event) {
      event = this.sign(
        0,
        JSON.stringify({
          name: 'github',
          display_name: 'GitHub',
          about: 'GitHub notifications and commands for Buzz.',
        }),
        [],
      );
      this.store.set(`${this.storagePrefix}.profile`, 'pending', event);
    }
    await this.publish(event);
    this.store.delete(`${this.storagePrefix}.profile`, 'pending');
  }

  async start(onMessage: (message: Message) => Promise<void>): Promise<void> {
    if (!this.stopped) throw new Error('Buzz client is already running.');
    this.onMessage = onMessage;
    await this.ensureRelayIdentity();
    await this.ensureProfile();
    if (
      this.store.get<number>(`${this.storagePrefix}.state`, 'started') ===
      undefined
    ) {
      this.store.transaction(() => {
        this.store.set(`${this.storagePrefix}.state`, 'started', now());
        this.store.set(`${this.storagePrefix}.state`, 'watermark', now());
      });
    }
    this.stopped = false;
    this.connect();
    await this.flush();
  }

  private accept(event: Event): void {
    const started =
      this.store.get<number>(`${this.storagePrefix}.state`, 'started') ?? now();
    if (
      event.kind !== 9 ||
      event.pubkey === this.pubkey ||
      event.created_at < started ||
      event.created_at > now() + 60 ||
      !toMessage(event) ||
      this.store.get(`${this.storagePrefix}.processed`, event.id) ||
      this.store.get(`${this.storagePrefix}.inbox`, event.id)
    )
      return;
    this.store.set(`${this.storagePrefix}.inbox`, event.id, {
      event,
      attempts: 0,
      next: 0,
    } satisfies Inbox);
  }

  private async catchUp(): Promise<void> {
    const end = now();
    const started =
      this.store.get<number>(`${this.storagePrefix}.state`, 'started') ?? end;
    const watermark =
      this.store.get<number>(`${this.storagePrefix}.state`, 'watermark') ??
      started;
    const events = await this.pages({
      kinds: [9],
      since: Math.max(started, watermark - OVERLAP_SECONDS),
      until: end,
    });
    // Advance only after every page is durably recorded, not after the newest page.
    this.store.transaction(() => {
      for (const event of events) this.accept(event);
      this.store.set(`${this.storagePrefix}.state`, 'watermark', end);
    });
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushWork().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async flushWork(): Promise<void> {
    if (this.onMessage && now() - this.lastCatchup >= 5) {
      try {
        await this.catchUp();
        this.lastCatchup = now();
      } catch (error) {
        this.log.warn(
          { error: this.errorText(error) },
          'Buzz history catch-up failed; cursor retained.',
        );
      }
    }
    if (this.authenticated && now() - this.lastChannels >= 30) {
      try {
        await this.subscribe();
      } catch (error) {
        this.log.warn(
          { error: this.errorText(error) },
          'Buzz channel refresh failed.',
        );
      }
    }
    if (this.onMessage) {
      const inbox = this.store
        .list<Inbox>(`${this.storagePrefix}.inbox`)
        .sort(
          (a, b) =>
            a.value.event.created_at - b.value.event.created_at ||
            a.key.localeCompare(b.key),
        );
      for (const { key, value } of inbox) {
        if (value.next > Date.now()) continue;
        try {
          await this.onMessage(toMessage(value.event)!);
          this.store.transaction(() => {
            this.store.set(
              `${this.storagePrefix}.processed`,
              key,
              value.event.created_at,
            );
            this.store.delete(`${this.storagePrefix}.inbox`, key);
          });
        } catch (error) {
          value.attempts += 1;
          value.next =
            Date.now() +
            Math.min(300_000, 1_000 * 2 ** Math.min(value.attempts, 9));
          this.store.set(`${this.storagePrefix}.inbox`, key, value);
          this.log.error(
            { eventId: key, error: this.errorText(error) },
            'Buzz message processing failed; will retry.',
          );
        }
      }
    }
    for (const { key, value } of this.store
      .list<Delivery>(`${this.storagePrefix}.outbox`)
      .sort((a, b) => a.value.order - b.value.order)) {
      if (value.failed || value.next > Date.now()) continue;
      // A reply or edit cannot race ahead of its still-pending parent.
      if (
        value.event.tags.some(
          (item) =>
            item[0] === 'e' &&
            this.store.get(`${this.storagePrefix}.outbox`, item[1]),
        )
      )
        continue;
      try {
        await this.publish(value.event);
        this.store.delete(`${this.storagePrefix}.outbox`, key);
      } catch (error) {
        value.attempts += 1;
        value.next =
          Date.now() +
          Math.min(300_000, 1_000 * 2 ** Math.min(value.attempts, 9));
        if (error instanceof RelayError && !error.retryable)
          value.failed = error.message;
        this.store.set(`${this.storagePrefix}.outbox`, key, value);
        this.log.error(
          {
            eventId: key,
            terminal: !!value.failed,
            error: this.errorText(error),
          },
          'Buzz delivery failed.',
        );
      }
    }
    // History overlap is bounded, so old processed IDs need not grow forever.
    const oldest =
      (this.store.get<number>(`${this.storagePrefix}.state`, 'watermark') ??
        0) -
      OVERLAP_SECONDS * 2;
    for (const { key, value } of this.store.list<number>(
      `${this.storagePrefix}.processed`,
    )) {
      if (value < oldest)
        this.store.delete(`${this.storagePrefix}.processed`, key);
    }
  }

  private errorText(error: unknown): string {
    // Only our own messages are guaranteed not to contain request bodies or credentials.
    return error instanceof RelayError
      ? error.message
      : 'Connection or processing error; retry pending.';
  }

  private connect(): void {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    const socket = new WebSocket(this.wsUrl, { handshakeTimeout: 15_000 });
    this.socket = socket;
    let authId: string | undefined;
    this.handshake = setTimeout(() => socket.terminate(), 20_000);
    socket.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as unknown[];
        if (frame[0] === 'AUTH' && typeof frame[1] === 'string') {
          const event = this.sign(22242, '', [
            ['relay', this.wsUrl],
            ['challenge', frame[1]],
          ]);
          authId = event.id;
          socket.send(JSON.stringify(['AUTH', event]));
        } else if (frame[0] === 'OK' && frame[1] === authId) {
          if (!frame[2]) {
            this.log.error({}, 'Buzz WebSocket authentication rejected.');
            socket.close();
            return;
          }
          clearTimeout(this.handshake);
          this.authenticated = true;
          this.connecting = false;
          this.lastChannels = 0;
          this.lastCatchup = 0;
          void this.flush().catch(() =>
            this.log.error({}, 'Buzz flush failed.'),
          );
        } else if (
          frame[0] === 'EVENT' &&
          frame[1] === 'buzz-apps' &&
          this.authenticated
        ) {
          const event = frame[2] as Event;
          if (verifyEvent(event)) this.accept(event);
        } else if (frame[0] === 'EOSE' && frame[1] === 'buzz-apps') {
          this.backoff = 1_000;
        } else if (frame[0] === 'CLOSED' && frame[1] === 'buzz-apps') {
          if (this.requestedCloses > 0) {
            this.requestedCloses -= 1;
            return;
          }
          this.log.warn(
            {},
            'Buzz live subscription closed; durable history polling continues.',
          );
          socket.close();
        }
      } catch {
        this.log.warn({}, 'Ignored malformed Buzz WebSocket frame.');
      }
    });
    socket.on('error', () =>
      this.log.warn(
        {},
        'Buzz WebSocket connection failed; reconnect scheduled.',
      ),
    );
    socket.on('close', () => {
      clearTimeout(this.handshake);
      this.authenticated = false;
      this.subscribed = false;
      this.requestedCloses = 0;
      this.connecting = false;
      if (!this.stopped) {
        this.reconnect = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(60_000, this.backoff * 2);
      }
    });
  }

  private async subscribe(): Promise<void> {
    const relay = await this.ensureRelayIdentity();
    const snapshots = await this.pages({
      kinds: [39002],
      authors: [relay],
      '#p': [this.pubkey],
    });
    const channels = [
      ...new Set(
        snapshots
          .filter(
            (event) =>
              event.pubkey === relay &&
              event.tags.some(
                (item) => item[0] === 'p' && item[1] === this.pubkey,
              ),
          )
          .map((event) => tag(event, 'd'))
          .filter(Boolean),
      ),
    ];
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      // A REQ with the same ID replaces the subscription atomically. Buzz sends
      // CLOSED acknowledgements for CLOSE, so closing before REQ creates a false failure.
      if (channels.length) {
        this.subscribed = true;
        this.socket.send(
          JSON.stringify([
            'REQ',
            'buzz-apps',
            { kinds: [9], '#h': channels, since: now(), limit: 0 },
          ]),
        );
      } else if (this.subscribed) {
        this.requestedCloses += 1;
        this.subscribed = false;
        this.socket.send(JSON.stringify(['CLOSE', 'buzz-apps']));
      }
    }
    this.lastChannels = now();
  }

  status(): {
    pending: number;
    failed: number;
    inbox: number;
    connected: boolean;
    admitted: boolean;
  } {
    const entries = this.store.list<Delivery>(`${this.storagePrefix}.outbox`);
    return {
      pending: entries.filter((row) => !row.value.failed).length,
      failed: entries.filter((row) => !!row.value.failed).length,
      inbox: this.store.list(`${this.storagePrefix}.inbox`).length,
      connected: this.authenticated,
      admitted: this.lastHttpSuccess > Date.now() - 60_000,
    };
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearTimeout(this.handshake);
    this.socket?.terminate();
    await this.flushing;
    this.authenticated = false;
  }
}
