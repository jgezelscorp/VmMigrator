import type { CredentialProvider } from './credential.js';

export type ArmMethod = 'PUT' | 'PATCH' | 'POST' | 'DELETE';

/**
 * Minimal ARM surface used by all engines. Paths are relative ("/subscriptions/...?api-version=...")
 * or absolute URLs (nextLink). Implemented by HttpArmClient and by in-memory mocks in tests.
 */
export interface ArmClient {
  get<T = unknown>(path: string): Promise<T>;
  /** GET a collection, following `nextLink` pagination, returning all `value` items */
  list<T = unknown>(path: string): Promise<T[]>;
  /** Mutating call; long-running operations are polled to completion */
  send<T = unknown>(method: ArmMethod, path: string, body?: unknown): Promise<T>;
}

export class ArmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ArmError';
  }
}

export interface HttpArmClientOptions {
  credential: CredentialProvider;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  pollIntervalMs?: number;
  lroTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpArmClient implements ArmClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly pollIntervalMs: number;
  private readonly lroTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private cached?: { token: string; expires: number };

  constructor(private readonly opts: HttpArmClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://management.azure.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 5;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.lroTimeoutMs = opts.lroTimeoutMs ?? 45 * 60_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.request('GET', path);
    return (await parseBody(res)) as T;
  }

  async list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: { value?: T[]; nextLink?: string } = await this.get(next);
      items.push(...(page.value ?? []));
      next = page.nextLink;
    }
    return items;
  }

  async send<T>(method: ArmMethod, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    const asyncUrl = res.headers.get('azure-asyncoperation');
    const location = res.headers.get('location');
    if (res.status === 202 || (res.status === 201 && (asyncUrl || location)) || (asyncUrl && res.status < 300)) {
      await this.waitForOperation(asyncUrl ?? location, res.headers.get('retry-after'));
      if (method === 'PUT' || method === 'PATCH') return this.get<T>(path);
      return undefined as T;
    }
    return (await parseBody(res)) as T;
  }

  private async waitForOperation(url: string | null, retryAfter: string | null): Promise<void> {
    if (!url) return;
    const deadline = Date.now() + this.lroTimeoutMs;
    let wait = retryAfter ? Number(retryAfter) * 1000 : this.pollIntervalMs;
    for (;;) {
      await this.sleep(Number.isFinite(wait) ? wait : this.pollIntervalMs);
      if (Date.now() > deadline) throw new ArmError(`Timed out waiting for operation ${url}`, 408);
      const res = await this.request('GET', url);
      const ra = res.headers.get('retry-after');
      wait = ra ? Number(ra) * 1000 : this.pollIntervalMs;
      if (res.status === 202) continue;
      const body = (await parseBody(res)) as { status?: string; error?: { code?: string; message?: string } } | undefined;
      const status = body?.status;
      if (!status || /^succeeded$/i.test(status)) return;
      if (/^(failed|canceled|cancelled)$/i.test(status)) {
        throw new ArmError(body?.error?.message ?? `Operation ${status}`, 500, body?.error?.code, body);
      }
    }
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expires - 120_000 > Date.now()) return this.cached.token;
    const t = await this.opts.credential.getToken();
    this.cached = { token: t.token, expires: t.expiresOnTimestamp };
    return t.token;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = /^https?:\/\//i.test(path) ? path : `${this.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${await this.token()}`,
          'content-type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if ((res.status === 429 || res.status === 503 || res.status === 502) && attempt < this.maxRetries) {
        const ra = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30_000, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const parsed = (await parseBody(res).catch(() => undefined)) as { error?: { code?: string; message?: string } } | undefined;
        throw new ArmError(
          `${method} ${stripQuery(url)} failed: ${res.status} ${parsed?.error?.code ?? ''} ${parsed?.error?.message ?? ''}`.trim(),
          res.status,
          parsed?.error?.code,
          parsed,
        );
      }
      return res;
    }
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

function stripQuery(url: string): string {
  return url.split('?')[0] ?? url;
}
