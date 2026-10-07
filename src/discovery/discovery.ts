import type { ArmClient } from '../azure/arm.js';
import type { SkuService } from '../azure/skus.js';
import { buildCandidateTargets, matchRetiringSeries, parseVcpuFromSize, type Catalog } from '../catalog/index.js';
import type { PowerState, VmDisk, VmExtension, VmInfo, VmNic } from '../domain/types.js';

export interface DiscoveryOptions {
  /** Defaults to all enabled subscriptions visible to the credential */
  subscriptionIds?: string[];
  retiringOnly?: boolean;
  /** Always include optional (v5) fallbacks in candidateTargets */
  includeOptionalTargets?: boolean;
  preferVendor?: 'AMD' | 'Intel';
  concurrency?: number;
  onWarning?: (message: string) => void;
}

export const COMPUTE_API = '2024-07-01';
const NETWORK_API = '2024-05-01';
const DISK_API = '2024-03-02';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

export function parseResourceId(id: string): { subscriptionId: string; resourceGroup: string; name: string } {
  const m = /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/[^/]+\/[^/]+\/([^/]+)/i.exec(id);
  return { subscriptionId: m?.[1] ?? '', resourceGroup: m?.[2] ?? '', name: m?.[3] ?? '' };
}

export async function listSubscriptionIds(arm: ArmClient): Promise<string[]> {
  const subs = await arm.list<{ subscriptionId: string; state?: string }>('/subscriptions?api-version=2022-12-01');
  return subs.filter((s) => !s.state || s.state === 'Enabled').map((s) => s.subscriptionId);
}

export interface SubscriptionLookups {
  nics: Map<string, Raw>;
  publicIps: Map<string, Raw>;
  disks: Map<string, Raw>;
}

async function loadLookups(arm: ArmClient, sub: string, warn: (m: string) => void): Promise<SubscriptionLookups> {
  const safe = async (what: string, path: string): Promise<Map<string, Raw>> => {
    try {
      const items = await arm.list<Raw>(path);
      return new Map(items.map((i) => [String(i.id).toLowerCase(), i]));
    } catch (e) {
      warn(`${sub}: could not list ${what}: ${(e as Error).message}`);
      return new Map();
    }
  };
  const [nics, publicIps, disks] = await Promise.all([
    safe('network interfaces', `/subscriptions/${sub}/providers/Microsoft.Network/networkInterfaces?api-version=${NETWORK_API}`),
    safe('public IPs', `/subscriptions/${sub}/providers/Microsoft.Network/publicIPAddresses?api-version=${NETWORK_API}`),
    safe('managed disks', `/subscriptions/${sub}/providers/Microsoft.Compute/disks?api-version=${DISK_API}`),
  ]);
  return { nics, publicIps, disks };
}

export function powerStateOf(statuses: Raw[] | undefined): PowerState {
  const code = statuses?.find((s) => typeof s.code === 'string' && s.code.startsWith('PowerState/'))?.code as string | undefined;
  switch (code?.slice('PowerState/'.length)) {
    case 'running':
      return 'running';
    case 'deallocated':
      return 'deallocated';
    case 'stopped':
      return 'stopped';
    case 'starting':
      return 'starting';
    case 'stopping':
    case 'deallocating':
      return 'stopping';
    default:
      return 'unknown';
  }
}

const ADE_EXTENSION_TYPES = /^AzureDiskEncryption(ForLinux)?$/i;

export function normalizeVm(raw: Raw, lookups: SubscriptionLookups | undefined, catalog: Catalog): VmInfo {
  const p = raw.properties ?? {};
  const iv = p.instanceView ?? {};
  const storage = p.storageProfile ?? {};
  const ids = parseResourceId(raw.id);

  const toDisk = (d: Raw): VmDisk => {
    const diskId: string | undefined = d.managedDisk?.id;
    const full = diskId ? lookups?.disks.get(diskId.toLowerCase()) : undefined;
    const size = d.diskSizeGB ?? full?.properties?.diskSizeGB;
    const sku = d.managedDisk?.storageAccountType ?? full?.sku?.name;
    return {
      name: d.name ?? full?.name ?? '',
      ...(diskId ? { id: diskId } : {}),
      ...(d.lun !== undefined ? { lun: d.lun } : {}),
      ...(size !== undefined ? { sizeGb: size } : {}),
      ...(sku ? { storageAccountType: sku } : {}),
      ...(d.caching ? { caching: d.caching } : {}),
      ...(Number(full?.properties?.maxShares ?? 1) > 1 ? { shared: true } : {}),
    };
  };

  const ivExt = new Map<string, Raw>((iv.extensions ?? []).map((e: Raw) => [String(e.name).toLowerCase(), e]));
  const extensions: VmExtension[] = (raw.resources ?? [])
    .filter((r: Raw) => /extensions$/i.test(r.type ?? ''))
    .map((r: Raw): VmExtension => {
      const status = ivExt.get(String(r.name).toLowerCase())?.statuses?.[0]?.code;
      return {
        name: r.name,
        ...(r.properties?.publisher ? { publisher: r.properties.publisher } : {}),
        ...(r.properties?.type ? { type: r.properties.type } : {}),
        ...(r.properties?.typeHandlerVersion ? { typeHandlerVersion: r.properties.typeHandlerVersion } : {}),
        ...(r.properties?.provisioningState ? { provisioningState: r.properties.provisioningState } : {}),
        ...(status ? { statusCode: status } : {}),
      };
    });

  const nics: VmNic[] = (p.networkProfile?.networkInterfaces ?? []).map((ref: Raw): VmNic => {
    const nic = lookups?.nics.get(String(ref.id).toLowerCase());
    const publicIps = (nic?.properties?.ipConfigurations ?? [])
      .map((c: Raw) => c.properties?.publicIPAddress?.id as string | undefined)
      .filter((x: string | undefined): x is string => !!x)
      .map((id: string) => {
        const ip = lookups?.publicIps.get(id.toLowerCase());
        return {
          id,
          ...(ip?.properties?.publicIPAllocationMethod ? { allocationMethod: ip.properties.publicIPAllocationMethod } : {}),
          ...(ip?.sku?.name ? { sku: ip.sku.name } : {}),
        };
      });
    return { id: ref.id, acceleratedNetworking: nic?.properties?.enableAcceleratedNetworking === true, publicIps };
  });

  const encryptionAtHost = p.securityProfile?.encryptionAtHost === true;
  const ade =
    extensions.some((e) => ADE_EXTENSION_TYPES.test(e.type ?? '')) ||
    storage.osDisk?.encryptionSettings?.enabled === true ||
    (iv.disks ?? []).some((d: Raw) => (d.encryptionSettings ?? []).some((s: Raw) => s.enabled === true));
  const desId: string | undefined = storage.osDisk?.managedDisk?.diskEncryptionSet?.id;

  const agentStatus = iv.vmAgent?.statuses?.[0];
  const vmSize: string = p.hardwareProfile?.vmSize ?? '';
  const generation = iv.hyperVGeneration as 'V1' | 'V2' | undefined;
  const img = storage.imageReference;
  const imgVersion: string | undefined = img?.exactVersion ?? img?.version;

  const vm: VmInfo = {
    id: raw.id,
    name: raw.name,
    subscriptionId: ids.subscriptionId,
    resourceGroup: ids.resourceGroup,
    location: raw.location,
    zones: raw.zones ?? [],
    vmSize,
    osType: (storage.osDisk?.osType as 'Windows' | 'Linux' | undefined) ?? 'Linux',
    ...(generation ? { hyperVGeneration: generation } : {}),
    diskControllerType: storage.diskControllerType === 'NVMe' ? 'NVMe' : 'SCSI',
    powerState: powerStateOf(iv.statuses),
    ...(p.availabilitySet?.id ? { availabilitySetId: p.availabilitySet.id } : {}),
    ...(p.proximityPlacementGroup?.id ? { proximityPlacementGroupId: p.proximityPlacementGroup.id } : {}),
    ...(nics.length ? { acceleratedNetworking: nics.some((n) => n.acceleratedNetworking) } : {}),
    tags: raw.tags ?? {},
    ...(p.provisioningState ? { provisioningState: p.provisioningState } : {}),
    priority: p.priority ?? 'Regular',
    ...(p.securityProfile?.securityType ? { securityType: p.securityProfile.securityType } : {}),
    ...(img
      ? {
          imageReference: {
            ...(img.publisher ? { publisher: img.publisher } : {}),
            ...(img.offer ? { offer: img.offer } : {}),
            ...(img.sku ? { sku: img.sku } : {}),
            ...(imgVersion ? { version: imgVersion } : {}),
            ...(img.id ? { id: img.id } : {}),
          },
        }
      : {}),
    ...(storage.osDisk ? { osDisk: toDisk(storage.osDisk) } : {}),
    dataDisks: (storage.dataDisks ?? []).map(toDisk),
    ephemeralOsDisk: storage.osDisk?.diffDiskSettings?.option === 'Local',
    encryption: { ade, encryptionAtHost, ...(desId ? { diskEncryptionSetId: desId } : {}) },
    extensions,
    nics,
    ...(iv.vmAgent
      ? {
          agent: {
            ...(iv.vmAgent.vmAgentVersion ? { version: iv.vmAgent.vmAgentVersion } : {}),
            ...(agentStatus?.displayStatus ? { status: agentStatus.displayStatus } : {}),
            ...(agentStatus?.time ? { lastHeartbeat: agentStatus.time } : {}),
          },
        }
      : {}),
    ...(p.capacityReservation?.capacityReservationGroup?.id
      ? { capacityReservationGroupId: p.capacityReservation.capacityReservationGroup.id }
      : {}),
    ...(p.host?.id ? { dedicatedHostId: p.host.id } : {}),
    ...(p.virtualMachineScaleSet?.id ? { virtualMachineScaleSetId: p.virtualMachineScaleSet.id } : {}),
  };

  const match = matchRetiringSeries(catalog, vmSize);
  if (match) {
    vm.retiringSeries = match.series;
    vm.retirementDate = match.retirementDate;
  }
  return vm;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function discoverVms(
  arm: ArmClient,
  skuService: SkuService,
  catalog: Catalog,
  opts: DiscoveryOptions = {},
): Promise<VmInfo[]> {
  const warn = opts.onWarning ?? (() => undefined);
  const subs = opts.subscriptionIds?.length ? opts.subscriptionIds : await listSubscriptionIds(arm);

  const perSub = await mapLimit(subs, opts.concurrency ?? 3, async (sub) => {
    const [rawVms, lookups] = await Promise.all([
      arm.list<Raw>(`/subscriptions/${sub}/providers/Microsoft.Compute/virtualMachines?api-version=${COMPUTE_API}&$expand=instanceView`),
      loadLookups(arm, sub, warn),
    ]);
    return rawVms.map((r) => normalizeVm(r, lookups, catalog));
  });

  let vms = perSub.flat();
  if (opts.retiringOnly) vms = vms.filter((v) => v.retiringSeries);

  await mapLimit(vms, opts.concurrency ?? 5, async (vm) => {
    if (!vm.retiringSeries) return;
    let vcpu = parseVcpuFromSize(vm.vmSize);
    let memoryGb: number | undefined;
    try {
      const sku = await skuService.getSku(vm.subscriptionId, vm.location, vm.vmSize);
      if (sku?.vcpus) {
        vcpu = sku.vcpus;
        memoryGb = sku.memoryGb || undefined;
      }
    } catch (e) {
      warn(`${vm.name}: SKU lookup failed, falling back to name parsing: ${(e as Error).message}`);
    }
    vm.candidateTargets = buildCandidateTargets(catalog, vm.retiringSeries, {
      ...(vcpu ? { vcpu } : {}),
      ...(memoryGb ? { memoryGb } : {}),
      osType: vm.osType,
      includeOptional: opts.includeOptionalTargets || vm.hyperVGeneration === 'V1',
      ...(opts.preferVendor ? { preferVendor: opts.preferVendor } : {}),
    });
  });

  return vms.sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId) || a.name.localeCompare(b.name));
}

/** Load and normalize a single VM by resource id (instance view, NICs, public IPs and managed disks included). */
export async function getVm(arm: ArmClient, catalog: Catalog, vmId: string): Promise<VmInfo> {
  const raw = await arm.get<Raw>(`${vmId}?api-version=${COMPUTE_API}&$expand=instanceView`);
  const lookups: SubscriptionLookups = { nics: new Map(), publicIps: new Map(), disks: new Map() };
  const fetchInto = async (target: Map<string, Raw>, id: string | undefined, api: string): Promise<Raw | undefined> => {
    if (!id) return undefined;
    try {
      const item = await arm.get<Raw>(`${id}?api-version=${api}`);
      target.set(id.toLowerCase(), item);
      return item;
    } catch {
      return undefined;
    }
  };
  const storage = raw.properties?.storageProfile ?? {};
  await Promise.all([
    ...(raw.properties?.networkProfile?.networkInterfaces ?? []).map(async (n: Raw) => {
      const nic = await fetchInto(lookups.nics, n.id, NETWORK_API);
      for (const c of nic?.properties?.ipConfigurations ?? []) {
        await fetchInto(lookups.publicIps, c.properties?.publicIPAddress?.id, NETWORK_API);
      }
    }),
    ...[storage.osDisk, ...(storage.dataDisks ?? [])].map((d: Raw) => fetchInto(lookups.disks, d?.managedDisk?.id, DISK_API)),
  ]);
  return normalizeVm(raw, lookups, catalog);
}
