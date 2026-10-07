import type { ArmClient } from './arm.js';

export interface SkuRestriction {
  type: 'Location' | 'Zone';
  reasonCode?: string;
  zones?: string[];
}

export interface SkuInfo {
  name: string;
  family: string;
  vcpus: number;
  memoryGb: number;
  maxResourceVolumeMB: number;
  maxDataDisks?: number;
  generations: string[];
  diskControllers: string[];
  acceleratedNetworking: boolean;
  premiumIO: boolean;
  ephemeralOsDisk: boolean;
  /** Zones where the size is offered in the queried location */
  zones: string[];
  restrictions: SkuRestriction[];
}

export interface UsageInfo {
  name: string;
  currentValue: number;
  limit: number;
}

interface RawSku {
  name: string;
  resourceType: string;
  family?: string;
  locations?: string[];
  locationInfo?: { location: string; zones?: string[] }[];
  capabilities?: { name: string; value: string }[];
  restrictions?: {
    type: 'Location' | 'Zone';
    reasonCode?: string;
    restrictionInfo?: { zones?: string[] };
  }[];
}

export function normalizeSku(raw: RawSku): SkuInfo {
  const cap = (n: string): string | undefined => raw.capabilities?.find((c) => c.name === n)?.value;
  const split = (v?: string): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    name: raw.name,
    family: raw.family ?? '',
    vcpus: Number(cap('vCPUs') ?? 0),
    memoryGb: Number(cap('MemoryGB') ?? 0),
    maxResourceVolumeMB: Number(cap('MaxResourceVolumeMB') ?? 0),
    ...(cap('MaxDataDiskCount') ? { maxDataDisks: Number(cap('MaxDataDiskCount')) } : {}),
    generations: split(cap('HyperVGenerations')),
    // Absent capability means the size predates the property and is SCSI only
    diskControllers: split(cap('DiskControllerTypes') ?? 'SCSI'),
    acceleratedNetworking: cap('AcceleratedNetworkingEnabled') === 'True',
    premiumIO: cap('PremiumIO') === 'True',
    ephemeralOsDisk: cap('EphemeralOSDiskSupported') === 'True',
    zones: raw.locationInfo?.flatMap((l) => l.zones ?? []) ?? [],
    restrictions: (raw.restrictions ?? []).map((r) => ({
      type: r.type,
      ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}),
      ...(r.restrictionInfo?.zones ? { zones: r.restrictionInfo.zones } : {}),
    })),
  };
}

/** Cached access to the Resource SKUs and Usages APIs (per subscription + location). */
export class SkuService {
  private readonly skuCache = new Map<string, Promise<SkuInfo[]>>();
  private readonly usageCache = new Map<string, Promise<UsageInfo[]>>();

  constructor(private readonly arm: ArmClient) {}

  getSkus(subscriptionId: string, location: string): Promise<SkuInfo[]> {
    const key = `${subscriptionId}/${location}`.toLowerCase();
    let p = this.skuCache.get(key);
    if (!p) {
      const filter = encodeURIComponent(`location eq '${location}'`);
      p = this.arm
        .list<RawSku>(`/subscriptions/${subscriptionId}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=${filter}`)
        .then((all) => all.filter((s) => s.resourceType === 'virtualMachines').map(normalizeSku));
      p.catch(() => this.skuCache.delete(key));
      this.skuCache.set(key, p);
    }
    return p;
  }

  async getSku(subscriptionId: string, location: string, name: string): Promise<SkuInfo | undefined> {
    return (await this.getSkus(subscriptionId, location)).find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  getUsages(subscriptionId: string, location: string): Promise<UsageInfo[]> {
    const key = `${subscriptionId}/${location}`.toLowerCase();
    let p = this.usageCache.get(key);
    if (!p) {
      p = this.arm
        .list<{ name: { value: string }; currentValue: number; limit: number }>(
          `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${location}/usages?api-version=2024-07-01`,
        )
        .then((all) => all.map((u) => ({ name: u.name.value, currentValue: u.currentValue, limit: u.limit })));
      p.catch(() => this.usageCache.delete(key));
      this.usageCache.set(key, p);
    }
    return p;
  }
}
