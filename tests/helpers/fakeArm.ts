import { ArmError, type ArmClient, type ArmMethod } from '../../src/azure/arm.js';

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
 * pre-checks, migration and post-checks; used by offline tests.
 */
export class FakeArm implements ArmClient {
  readonly calls: RecordedCall[] = [];
  readonly vms = new Map<string, Raw>();
  readonly snapshots = new Map<string, Raw>();
  /** Managed disks that exist independently of a VM (created from snapshots, or left behind by a deleted VM) */
  readonly disks = new Map<string, Raw>();
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
    if (/\/providers\/Microsoft\.Compute\/disks\/[^/]+$/i.test(p)) return this.sendDisk<T>('GET', p, undefined);

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
    if (/\/virtualMachines\/[^/]+\/extensions$/i.test(p)) {
      const vm = this.vmFor(p);
      return clone(
        (vm?.resources ?? []).map((r: Raw) => ({ id: `${vm.id}/extensions/${r.name}`, name: r.name, properties: r.properties })),
      ) as T[];
    }
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

    if (/\/providers\/Microsoft\.Compute\/disks\/[^/]+$/i.test(p)) return this.sendDisk<T>(method, p, body as Raw);
    if (/\/virtualMachines\/[^/]+$/i.test(p) && method === 'DELETE') return this.deleteVm<T>(p, vm);
    if (/\/virtualMachines\/[^/]+$/i.test(p) && method === 'PUT') return this.createVm<T>(p, vm, body as Raw);
    if (vm && method === 'PUT' && /\/virtualMachines\/[^/]+\/extensions\/[^/]+$/i.test(p)) {
      const name = p.split('/').pop() as string;
      const ext = { type: 'Microsoft.Compute/virtualMachines/extensions', name, properties: { ...(body as Raw)?.properties, provisioningState: 'Succeeded' } };
      vm.resources = [...(vm.resources ?? []).filter((r: Raw) => r.name !== name), ext];
      vm.properties.instanceView.extensions = [
        ...(vm.properties.instanceView.extensions ?? []).filter((r: Raw) => r.name !== name),
        { name, statuses: [{ code: 'ProvisioningState/succeeded' }] },
      ];
      return clone(ext) as T;
    }

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

  private diskRefs(vm: Raw): { id: string; name: string; role: 'os' | 'data'; deleteOption?: string }[] {
    const sp = vm.properties?.storageProfile ?? {};
    return [
      ...(sp.osDisk?.managedDisk?.id ? [{ id: sp.osDisk.managedDisk.id, name: sp.osDisk.name, role: 'os' as const, deleteOption: sp.osDisk.deleteOption }] : []),
      ...(sp.dataDisks ?? []).map((d: Raw) => ({ id: d.managedDisk.id, name: d.name, role: 'data' as const, deleteOption: d.deleteOption })),
    ];
  }

  private attachedTo(diskId: string): Raw | undefined {
    return [...this.vms.values()].find((v) => this.diskRefs(v).some((d) => norm(d.id) === norm(diskId)));
  }

  private diskOf(p: string): Raw | undefined {
    const stored = this.disks.get(norm(p));
    if (stored) return stored;
    const owner = this.attachedTo(p);
    if (!owner) return undefined;
    const ref = this.diskRefs(owner).find((d) => norm(d.id) === norm(p));
    const sp = owner.properties.storageProfile;
    const raw = ref?.role === 'os' ? sp.osDisk : (sp.dataDisks ?? []).find((d: Raw) => norm(d.managedDisk.id) === norm(p));
    return {
      id: p,
      name: p.split('/').pop(),
      location: owner.location,
      ...(owner.zones ? { zones: owner.zones } : {}),
      sku: { name: raw?.managedDisk?.storageAccountType ?? 'Premium_LRS' },
      properties: {
        diskSizeGB: raw?.diskSizeGB ?? 64,
        ...(ref?.role === 'os' ? { osType: sp.osDisk.osType, hyperVGeneration: owner.properties.instanceView?.hyperVGeneration ?? 'V2' } : {}),
      },
    };
  }

  private sendDisk<T>(method: string, p: string, body: Raw): T {
    if (method === 'PUT') {
      if (this.diskOf(p)) throw new ArmError(`Disk ${p.split('/').pop()} already exists`, 409, 'OperationNotAllowed');
      const src = body?.properties?.creationData?.sourceResourceId as string | undefined;
      const snap = src ? this.snapshots.get(norm(src)) : undefined;
      if (body?.properties?.creationData?.createOption === 'Copy' && !snap) {
        throw new ArmError(`Source snapshot ${src ?? ''} was not found`, 404, 'ResourceNotFound');
      }
      const disk = {
        id: p,
        name: p.split('/').pop(),
        ...body,
        properties: { diskSizeGB: snap?.properties?.diskSizeGB ?? 64, ...body?.properties, provisioningState: 'Succeeded', diskState: 'Unattached' },
      };
      this.disks.set(norm(p), disk);
      return clone(disk) as T;
    }
    const disk = this.diskOf(p);
    if (!disk) throw new ArmError(`Disk ${p.split('/').pop()} not found`, 404, 'ResourceNotFound');
    if (method === 'DELETE') {
      if (this.attachedTo(p)) throw new ArmError('Disk is attached to a virtual machine', 409, 'OperationNotAllowed');
      this.disks.delete(norm(p));
      return undefined as T;
    }
    return clone(disk) as T;
  }

  private deleteVm<T>(p: string, vm: Raw | undefined): T {
    if (!vm) throw new ArmError('The virtual machine was not found', 404, 'ResourceNotFound');
    const gen = vm.properties.instanceView?.hyperVGeneration ?? 'V2';
    for (const ref of this.diskRefs(vm)) {
      if (ref.deleteOption === 'Delete') continue;
      const d = this.diskOf(ref.id);
      if (d) this.disks.set(norm(ref.id), { ...d, properties: { ...d.properties, ...(ref.role === 'os' ? { hyperVGeneration: gen } : {}) } });
    }
    this.vms.delete(norm(vm.id));
    return undefined as T;
  }

  private createVm<T>(p: string, existing: Raw | undefined, body: Raw): T {
    if (existing) throw new ArmError('Updating a virtual machine with PUT is not supported by this fake', 409, 'OperationNotAllowed');
    const props = body?.properties ?? {};
    const size: string = props.hardwareProfile?.vmSize;
    const sku = this.skus.find((s) => norm(s.name) === norm(size ?? ''));
    if (!sku) throw new ArmError(`The requested VM size ${size} is not available in this region.`, 409, 'SkuNotAvailable');
    const capOf = (n: string): string => (sku.capabilities ?? []).find((c: Raw) => c.name === n)?.value ?? '';
    const ctl = props.storageProfile?.diskControllerType ?? 'SCSI';
    if (!capOf('DiskControllerTypes').split(',').map((s: string) => s.trim()).includes(ctl)) {
      throw new ArmError(`Size ${size} does not support disk controller ${ctl}`, 409, 'OperationNotAllowed');
    }
    const sp = props.storageProfile ?? {};
    const attach = [sp.osDisk, ...(sp.dataDisks ?? [])].filter(Boolean);
    let osGen = 'V2';
    for (const d of attach) {
      const id: string | undefined = d.managedDisk?.id;
      const disk = id ? this.diskOf(id) : undefined;
      if (d.createOption !== 'Attach' || !disk) throw new ArmError(`Disk ${id ?? d.name} was not found`, 404, 'ResourceNotFound');
      if (this.attachedTo(id as string)) throw new ArmError(`Disk ${d.name} is already attached to a virtual machine`, 409, 'OperationNotAllowed');
      if (d === sp.osDisk) osGen = disk.properties?.hyperVGeneration ?? 'V2';
    }
    if (props.securityProfile?.securityType === 'TrustedLaunch') osGen = 'V2';
    if (osGen === 'V1' && !capOf('HyperVGenerations').includes('V1')) {
      throw new ArmError(`Size ${size} only supports Generation 2 VMs`, 409, 'OperationNotAllowed');
    }
    if (osGen === 'V2' && !capOf('HyperVGenerations').includes('V2')) {
      throw new ArmError(`Size ${size} only supports Generation 1 VMs`, 409, 'OperationNotAllowed');
    }
    const vm: Raw = {
      ...clone(body),
      id: p,
      name: p.split('/').pop(),
      resources: [],
      properties: {
        ...clone(props),
        provisioningState: 'Succeeded',
        instanceView: { hyperVGeneration: osGen, statuses: [], vmAgent: { vmAgentVersion: '2.12.0.2', statuses: [] }, extensions: [] },
      },
    };
    this.vms.set(norm(p), vm);
    this.setPower(vm, 'running');
    return clone(vm) as T;
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
    if (props.securityProfile) {
      if (power !== 'deallocated') throw new ArmError('The VM must be deallocated to change the security profile.', 409, 'OperationNotAllowed');
      vm.properties.securityProfile = { ...vm.properties.securityProfile, ...props.securityProfile };
      if (props.securityProfile.securityType === 'TrustedLaunch') vm.properties.instanceView.hyperVGeneration = 'V2';
    }
    if (newSize && newSize !== this.currentSize(vm)) {
      const target = this.skus.find((s) => norm(s.name) === norm(newSize));
      if (!target) throw new ArmError(`The requested VM size ${newSize} is not available in this region.`, 409, 'SkuNotAvailable');
      const cap = (s: Raw, n: string): string => (s?.capabilities ?? []).find((c: Raw) => c.name === n)?.value ?? '';
      const current = this.skus.find((s) => norm(s.name) === norm(this.currentSize(vm)));
      if (sp.osDisk?.osType === 'Windows' && Number(cap(current, 'MaxResourceVolumeMB')) > 0 && Number(cap(target, 'MaxResourceVolumeMB')) === 0) {
        throw new ArmError('Cannot resize a Windows VM with a local temp disk to a size without one (OperationNotAllowed).', 409, 'OperationNotAllowed');
      }
      if (vm.properties.instanceView?.hyperVGeneration === 'V1' && !cap(target, 'HyperVGenerations').includes('V1')) {
        throw new ArmError(`Size ${newSize} only supports Generation 2 VMs`, 409, 'OperationNotAllowed');
      }
      vm.properties.hardwareProfile.vmSize = newSize;
    }
    if (newCtl) sp.diskControllerType = newCtl;
    const dd: Raw[] | undefined = props.storageProfile?.dataDisks;
    if (props.storageProfile?.osDisk?.deleteOption && sp.osDisk) sp.osDisk.deleteOption = props.storageProfile.osDisk.deleteOption;
    for (const d of dd ?? []) {
      const t = (sp.dataDisks ?? []).find((x: Raw) => x.lun === d.lun);
      if (t && d.deleteOption) t.deleteOption = d.deleteOption;
    }
    const nics: Raw[] | undefined = props.networkProfile?.networkInterfaces;
    for (const n of nics ?? []) {
      const t = (vm.properties.networkProfile.networkInterfaces ?? []).find((x: Raw) => norm(x.id) === norm(n.id));
      if (t && n.properties?.deleteOption) t.properties = { ...t.properties, deleteOption: n.properties.deleteOption };
    }
    if (body?.tags) vm.tags = { ...vm.tags, ...body.tags };
    return vm;
  }

  powerOf(vm: Raw): string {
    const code = (vm.properties?.instanceView?.statuses ?? []).find((s: Raw) => String(s.code).startsWith('PowerState/'))?.code as string | undefined;
    return code?.slice('PowerState/'.length) ?? 'unknown';
  }
}
