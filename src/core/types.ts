import type { Event } from 'nostr-tools';
export interface Config {
  relayUrl: string; botKey: string; authTag?: string;
  dataDir: string; publicUrl: string; host: string; port: number;
  encryptionKey: string; enabledApps: string[]; admins: string[];
  github?: { appId: string; privateKey: string; clientId: string; clientSecret: string; webhookSecret: string };
}
export interface Subscription { channel: string; target: string; features: string[]; settings: Record<string, unknown>; createdBy: string }
export interface Account { pubkey: string; login: string; token: string; refreshToken?: string; expiresAt?: number }
export interface Message { id: string; channel: string; author: string; content: string; tags: string[][]; createdAt: number; root?: string }
export interface SendOptions { root?: string; broadcast?: boolean; mentions?: string[]; edit?: string }
export interface BuzzTransport {
  pubkey: string;
  send(channel: string, content: string, options?: SendOptions): Promise<string>;
  dm(pubkey: string, content: string): Promise<string>;
  canManage(channel: string, pubkey: string): Promise<boolean>;
  query(filters: Record<string, unknown>[]): Promise<Event[]>;
}
export interface StoreApi {
  get<T>(space: string, key: string): T | undefined;
  set(space: string, key: string, value: unknown): void;
  delete(space: string, key: string): void;
  list<T>(space: string): { key: string; value: T }[];
  once(space: string, key: string, value?: unknown): boolean;
  transaction<T>(fn: () => T): T;
  enqueue(queue: string, id: string, payload: unknown, at?: number): void;
  account(pubkey: string): Account | undefined;
  saveAccount(account: Account): void;
  removeAccount(pubkey: string): void;
}
export interface AppContext { config: Config; store: StoreApi; buzz: BuzzTransport; log: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void } }
export interface BuzzApp {
  id: string;
  onMessage(message: Message): Promise<void>;
  onWebhook?(event: string, payload: unknown, delivery: string): Promise<void>;
  tick?(): Promise<void>;
}
