import type { ArmClient, ArmMethod } from '../../src/azure/arm.js';
import { ArmError } from '../../src/azure/arm.js';

type Matcher = string | RegExp;
type Handler = (path: string, body?: unknown) => unknown;

interface Route {
  method: 'GET' | 'LIST' | ArmMethod;
  match: Matcher;
  handler: Handler;
}

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

const matches = (m: Matcher, path: string): boolean => (typeof m === 'string' ? path.includes(m) : m.test(path));

/** Offline ARM double: first matching route wins, unmatched calls throw 404. */
export class MockArm implements ArmClient {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Route[] = [];

  onGet(match: Matcher, value: unknown | Handler): this {
    this.routes.push({ method: 'GET', match, handler: typeof value === 'function' ? (value as Handler) : () => value });
    return this;
  }

  onList(match: Matcher, items: unknown[] | Handler): this {
    this.routes.push({ method: 'LIST', match, handler: typeof items === 'function' ? (items as Handler) : () => items });
    return this;
  }

  /** Added routes take priority so tests can override defaults */
  onSend(method: ArmMethod, match: Matcher, handler: Handler = () => undefined): this {
    this.routes.unshift({ method, match, handler });
    return this;
  }

  private find(method: Route['method'], path: string): Route | undefined {
    return this.routes.find((r) => r.method === method && matches(r.match, path));
  }

  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
    const r = this.find('GET', path);
    if (!r) throw new ArmError(`MockArm: no GET route for ${path}`, 404, 'NotFound');
    return r.handler(path) as T;
  }

  async list<T>(path: string): Promise<T[]> {
    this.calls.push({ method: 'GET', path });
    const r = this.find('LIST', path);
    if (!r) throw new ArmError(`MockArm: no LIST route for ${path}`, 404, 'NotFound');
    return r.handler(path) as T[];
  }

  async send<T>(method: ArmMethod, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    const r = this.find(method, path);
    if (!r) throw new ArmError(`MockArm: no ${method} route for ${path}`, 404, 'NotFound');
    return r.handler(path, body) as T;
  }
}
