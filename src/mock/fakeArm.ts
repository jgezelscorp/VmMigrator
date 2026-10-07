import { ArmError, type ArmClient, type ArmMethod } from '../azure/arm.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

export interface Injection {
  method: ArmMethod | 'GET';
  match: RegExp | string;
  error: ArmError;
  /** Only fail while this predicate holds (receives the addressed VM, if any) */
  when?: (vm: Raw | undefined) => boolean;
  /** Number of times to fail; default: always */
  times?: number;
}

export interface FakeArmOptions {
  subscriptions?: { subscriptionId: string; displayName: string }[];
  vms?: Raw[];
  skus?: Raw[];
  /** Simulated duration of mutating calls, to make UI progress visible */
  latencyMs?: number;
  now?: () => Date;
}

const norm = (s: string): string => s.toLowerCase();
const pathOnly = (p: string): string => (p.split('?')[0] ?? p).replace(/^https?:\/\/[^/]+/i, '');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Stateful in-memory Azure Resource Manager double. Implements enough of Compute/Network/SKU APIs for discovery,
 * pre-checks, migration and post-checks; used by offline tests and by the VMM_MOCK=1 demo mode.
 */
export class FakeArm implements ArmClient {
  readonly calls: RecordedCall[] = [];
  readonly vms = new Map<string, Raw>();
  readonly snapshots = new Map<string, Raw>();
  readonly subscriptions: { subscriptionId: string; displayName: string }[];
  skus: Raw[];
  latencyMs: number;
  /** Output returned by VM run-command (post-check guest probe) */
  runCommandOutput = 'VMM_PROBE_OK';
  private readonly injections: (Injection & { used: number })[] = [];
  private readonly now: () => Date;

  constructor(opts: FakeArmOptions = {}) {
    this.subscriptions = opts.subscriptions ?? [];
    this.skus = opts.skus ?? [];
    this.latencyMs = opts.latencyMs ?? 0;
    this.now = opts.now ?? ((): Date => new Date());
    for (const vm of opts.vms ?? []) this.addVm(vm);
  }

  addVm(vm: Raw): void {
    this.vms.set(norm(vm.id), vm);
  }

  getVm(idOrName: string): Raw | undefined {
    const direct = this.vms.get(norm(idOrName));
    if (direct) return direct;
    return [...this.vms.values()].find((v) => norm(v.name) === norm(idOrName));
  }

  inject(i: Injection): this {
    this.injections.push({ ...i, used: 0 });
    return this;
  }

  callsTo(method: string, match: RegExp | string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && (typeof match === 'string' ? c.path.includes(match) : match.test(c.path)));
  }

  private vmFor(path: string): Raw | undefined {
    const m = /\/virtualMachines\/([^/?]+)/i.exec(path);
    if (!m?.[1]) return undefined;
    const sub = /\/subscriptions\/([^/]+)/i.exec(path)?.[1];
    return [...this.vms.values()].find((v) => norm(v.name) === norm(m[1]!) && (!sub || norm(v.id).includes(norm(`/subscriptions/${sub}/`))));
  }

  private checkInjections(method: string, path: string): void {
    const vm = this.vmFor(path);
    for (const inj of this.injections) {
      if (inj.method !== method) continue;
      const hit = typeof inj.match === 'string' ? path.includes(inj.match) : inj.match.test(path);
      if (!hit || (inj.when && !inj.when(vm))) continue;
      if (inj.times !== undefined && inj.used >= inj.times) continue;
      inj.used++;
      throw inj.error;
    }
  }

  private sleep(): Promise<void> {
    return this.latencyMs > 0 ? new Promise((r) => setTimeout(r, this.latencyMs)) : Promise.resolve();
  }

  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
    this.checkInjections('GET', path);
    const p = pathOnly(path);

    const vm = this.vmFor(p);
    if (vm && /\/virtualMachines\/[^/]+$/i.test(p)) return clone(vm) as T;

    const snap = this.snapshots.get(norm(p));
    if (snap) return clone(snap) as T;

    if (/\/availabilitySets\//i.test(p)) {
      const members = [...this.vms.values()].filter((v) => norm(v.properties?.availabilitySet?.id ?? '') === norm(p));
      return { id: p, properties: { virtualMachines: members.map((v) => ({ id: v.id })) } } as T;
    }
    if (/\/providers\/Microsoft\.Network\/networkInterfaces\/[^/]+$/i.test(p)) {
      return { id: p, name: p.split('/').pop(), properties: { enableAcceleratedNetworking: true, ipConfigurations: [{ properties: {} }] } } as T;
    }
    if (/\/artifacttypes\/vmimage\//i.test(p)) {
      return { properties: { features: [{ name: 'DiskControllerTypes', value: 'SCSI, NVMe' }] } } as T;
    }
    throw new ArmError(`FakeArm: GET ${p} not found`, 404, 'ResourceNotFound');
  }

  async list<T>(path: string): Promise<T[]> {
    this.calls.push({ method: 'GET', path });
    this.checkInjections('GET', path);
    const p = pathOnly(path);
    const sub = /\/subscriptions\/([^/]+)/i.exec(p)?.[1];
    const subVms = [...this.vms.values()].filter((v) => !sub || norm(v.id).startsWith(norm(`/subscriptions/${sub}/`)));

    if (/^\/subscriptions$/i.test(p)) {
      return this.subscriptions.map((s) => ({ ...s, state: 'Enabled' })) as T[];
    }
    if (/\/providers\/Microsoft\.Compute\/virtualMachines$/i.test(p)) return clone(subVms) as T[];
    if (/\/providers\/Microsoft\.Compute\/skus$/i.test(p)) return clone(this.skus) as T[];
    if (/\/usages$/i.test(p)) {
      const families = new Set<string>(this.skus.map((s) => s.family).filter(Boolean));
      return [
        { name: { value: 'cores' }, currentValue: 10, limit: 1000 },
        ...[...families].map((f) => ({ name: { value: f }, currentValue: 0, limit: 200 })),
      ] as T[];
    }
    if (/\/providers\/Microsoft\.Network\/networkInterfaces$/i.test(p)) {
      return subVms.flatMap((v) =>
        (v.properties?.networkProfile?.networkInterfaces ?? []).map((n: Raw) => ({
          id: n.id,
          name: String(n.id).split('/').pop(),
          properties: { enableAcceleratedNetworking: true, ipConfigurations: [{ properties: {} }] },
        })),
      ) as T[];
    }
    if (/\/providers\/Microsoft\.Network\/publicIPAddresses$/i.test(p)) return [];
    if (/\/providers\/Microsoft\.Compute\/disks$/i.test(p)) return [];
    if (/\/providers\/Microsoft\.Authorization\/locks$/i.test(p)) return [];
    throw new ArmError(`FakeArm: LIST ${p} not found`, 404, 'ResourceNotFound');
  }

  async send<T>(method: ArmMethod, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    this.checkInjections(method, path);
    await this.sleep();
    const p = pathOnly(path);
    const vm = this.vmFor(p);

    if (method === 'POST' && /ResourceGraph\/resources$/i.test(p)) return { data: [] } as T;

    if (vm) {
      const action = /\/virtualMachines\/[^/]+\/([^/]+)$/i.exec(p)?.[1]?.toLowerCase();
      if (method === 'POST' && action === 'deallocate') {
        this.setPower(vm, 'deallocated');
        return undefined as T;
      }
      if (method === 'POST' && action === 'start') {
        this.start(vm);
        return undefined as T;
      }
      if (method === 'POST' && action === 'runcommand') {
        return { value: [{ code: 'ComponentStatus/StdOut/succeeded', message: this.runCommandOutput }] } as T;
      }
      if (method === 'PATCH' && !action) return clone(this.patch(vm, body as Raw)) as T;
    }

    if (/\/providers\/Microsoft\.Compute\/snapshots\/[^/]+$/i.test(p)) {
      if (method === 'PUT') {
        const b = body as Raw;
        const snap = { id: p, name: p.split('/').pop(), location: b?.location, ...b, properties: { ...b?.properties, provisioningState: 'Succeeded', timeCreated: this.now().toISOString() } };
        this.snapshots.set(norm(p), snap);
        return clone(snap) as T;
      }
      if (method === 'DELETE') {
        this.snapshots.delete(norm(p));
        return undefined as T;
      }
    }
    throw new ArmError(`FakeArm: ${method} ${p} not supported`, 404, 'ResourceNotFound');
  }

  private setPower(vm: Raw, state: string): void {
    const iv = (vm.properties.instanceView ??= { statuses: [] });
    iv.statuses = [
      { code: 'ProvisioningState/succeeded' },
      { code: `PowerState/${state}`, displayStatus: `VM ${state}` },
    ];
    if (state === 'running' && iv.vmAgent) {
      iv.vmAgent.statuses = [{ code: 'ProvisioningState/succeeded', displayStatus: 'Ready', time: this.now().toISOString() }];
    }
  }

  private currentSize(vm: Raw): string {
    return vm.properties.hardwareProfile.vmSize as string;
  }

  private start(vm: Raw): void {
    const size = this.currentSize(vm);
    const sku = this.skus.find((s) => norm(s.name) === norm(size));
    const restricted = (sku?.restrictions ?? []).some((r: Raw) => r.type === 'Location');
    if (!sku || restricted) {
      throw new ArmError(`Allocation failed: size ${size} is not available.`, 409, 'SkuNotAvailable');
    }
    this.setPower(vm, 'running');
  }

  private patch(vm: Raw, body: Raw): Raw {
    const power = this.powerOf(vm);
    const props = body?.properties ?? {};
    const newSize: string | undefined = props.hardwareProfile?.vmSize;
    const newCtl: string | undefined = props.storageProfile?.diskControllerType;
    const sp = vm.properties.storageProfile;
    if (newCtl && newCtl !== (sp.diskControllerType ?? 'SCSI') && power !== 'deallocated') {
      throw new ArmError('Changing the disk controller type requires the VM to be deallocated.', 409, 'OperationNotAllowed');
    }
    if (newSize && newSize !== this.currentSize(vm)) {
      if (!this.skus.some((s) => norm(s.name) === norm(newSize))) {
        throw new ArmError(`The requested VM size ${newSize} is not available in this region.`, 409, 'SkuNotAvailable');
      }
      vm.properties.hardwareProfile.vmSize = newSize;
    }
    if (newCtl) sp.diskControllerType = newCtl;
    if (body?.tags) vm.tags = { ...vm.tags, ...body.tags };
    return vm;
  }

  powerOf(vm: Raw): string {
    const code = (vm.properties?.instanceView?.statuses ?? []).find((s: Raw) => String(s.code).startsWith('PowerState/'))?.code as string | undefined;
    return code?.slice('PowerState/'.length) ?? 'unknown';
  }
}
