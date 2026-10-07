import { MockArm } from './mockArm.js';

export const SUB = '00000000-0000-0000-0000-000000000001';
export const RG = 'rg-demo';
export const LOC = 'westeurope';

export const vmId = (name: string, sub = SUB): string =>
  `/subscriptions/${sub}/resourceGroups/${RG}/providers/Microsoft.Compute/virtualMachines/${name}`;
export const nicId = (name: string): string =>
  `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/networkInterfaces/${name}-nic`;
export const diskId = (name: string): string =>
  `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/disks/${name}`;

export interface RawVmOptions {
  name: string;
  size?: string;
  os?: 'Windows' | 'Linux';
  gen?: 'V1' | 'V2';
  power?: string;
  zones?: string[];
  controller?: string;
  extensions?: { name: string; type: string; publisher?: string; state?: string }[];
  dataDisks?: number;
  availabilitySetId?: string;
  ephemeral?: boolean;
  priority?: string;
  encryptionAtHost?: boolean;
  tags?: Record<string, string>;
  heartbeat?: string;
}

export function rawVm(o: RawVmOptions): Record<string, unknown> {
  const os = o.os ?? 'Linux';
  return {
    id: vmId(o.name),
    name: o.name,
    location: LOC,
    tags: o.tags ?? { purpose: 'vmmigrator-demo' },
    ...(o.zones ? { zones: o.zones } : {}),
    resources: (o.extensions ?? []).map((e) => ({
      type: 'Microsoft.Compute/virtualMachines/extensions',
      name: e.name,
      properties: { publisher: e.publisher ?? 'Microsoft.Azure', type: e.type, typeHandlerVersion: '1.0', provisioningState: e.state ?? 'Succeeded' },
    })),
    properties: {
      provisioningState: 'Succeeded',
      hardwareProfile: { vmSize: o.size ?? 'Standard_D2s_v3' },
      ...(o.priority ? { priority: o.priority } : {}),
      ...(o.availabilitySetId ? { availabilitySet: { id: o.availabilitySetId } } : {}),
      ...(o.encryptionAtHost ? { securityProfile: { encryptionAtHost: true } } : {}),
      storageProfile: {
        imageReference: { publisher: os === 'Linux' ? 'Canonical' : 'MicrosoftWindowsServer', offer: os === 'Linux' ? 'ubuntu-24_04-lts' : 'WindowsServer', sku: os === 'Linux' ? 'server' : '2022-datacenter-azure-edition', version: 'latest', exactVersion: '1.0.0' },
        osDisk: {
          osType: os,
          name: `${o.name}-os`,
          managedDisk: { id: diskId(`${o.name}-os`), storageAccountType: 'Premium_LRS' },
          caching: 'ReadWrite',
          ...(o.ephemeral ? { diffDiskSettings: { option: 'Local' } } : {}),
        },
        dataDisks: Array.from({ length: o.dataDisks ?? 0 }, (_, i) => ({
          lun: i,
          name: `${o.name}-data${i}`,
          diskSizeGB: 64,
          managedDisk: { id: diskId(`${o.name}-data${i}`), storageAccountType: 'Premium_LRS' },
        })),
        ...(o.controller ? { diskControllerType: o.controller } : {}),
      },
      networkProfile: { networkInterfaces: [{ id: nicId(o.name) }] },
      instanceView: {
        hyperVGeneration: o.gen ?? 'V2',
        statuses: [
          { code: 'ProvisioningState/succeeded' },
          { code: `PowerState/${o.power ?? 'running'}`, displayStatus: `VM ${o.power ?? 'running'}` },
        ],
        vmAgent: {
          vmAgentVersion: '2.12.0',
          statuses: [{ code: 'ProvisioningState/succeeded', displayStatus: 'Ready', time: o.heartbeat ?? new Date().toISOString() }],
        },
        extensions: (o.extensions ?? []).map((e) => ({
          name: e.name,
          statuses: [{ code: `ProvisioningState/${(e.state ?? 'Succeeded').toLowerCase()}` }],
        })),
      },
    },
  };
}

export interface RawSkuOptions {
  name: string;
  family: string;
  vcpus: number;
  memoryGb: number;
  tempMb?: number;
  gens?: string;
  controllers?: string;
  an?: boolean;
  premium?: boolean;
  ephemeral?: boolean;
  zones?: string[];
  restrictions?: { type: 'Location' | 'Zone'; zones?: string[] }[];
  maxDataDisks?: number;
}

export function rawSku(o: RawSkuOptions): Record<string, unknown> {
  const cap = (name: string, value: string): { name: string; value: string } => ({ name, value });
  return {
    resourceType: 'virtualMachines',
    name: o.name,
    family: o.family,
    locations: [LOC],
    locationInfo: [{ location: LOC, zones: o.zones ?? ['1', '2', '3'] }],
    capabilities: [
      cap('vCPUs', String(o.vcpus)),
      cap('MemoryGB', String(o.memoryGb)),
      cap('MaxResourceVolumeMB', String(o.tempMb ?? 0)),
      cap('HyperVGenerations', o.gens ?? 'V1,V2'),
      ...(o.controllers ? [cap('DiskControllerTypes', o.controllers)] : []),
      cap('AcceleratedNetworkingEnabled', o.an === false ? 'False' : 'True'),
      cap('PremiumIO', o.premium === false ? 'False' : 'True'),
      cap('EphemeralOSDiskSupported', o.ephemeral ? 'True' : 'False'),
      cap('MaxDataDiskCount', String(o.maxDataDisks ?? 8)),
    ],
    restrictions: (o.restrictions ?? []).map((r) => ({
      type: r.type,
      reasonCode: 'NotAvailableForSubscription',
      restrictionInfo: { locations: [LOC], zones: r.zones ?? [] },
    })),
  };
}

export const DEFAULT_SKUS = [
  rawSku({ name: 'Standard_D2s_v3', family: 'standardDSv3Family', vcpus: 2, memoryGb: 8, tempMb: 16384, controllers: 'SCSI' }),
  rawSku({ name: 'Standard_E2s_v3', family: 'standardESv3Family', vcpus: 2, memoryGb: 16, tempMb: 32768, controllers: 'SCSI' }),
  rawSku({ name: 'Standard_DS2_v2', family: 'standardDSv2Family', vcpus: 2, memoryGb: 7, tempMb: 14336, controllers: 'SCSI' }),
  rawSku({ name: 'Standard_A2_v2', family: 'standardAv2Family', vcpus: 2, memoryGb: 4, tempMb: 20480, controllers: 'SCSI', premium: false }),
  rawSku({ name: 'Standard_F2s_v2', family: 'standardFSv2Family', vcpus: 2, memoryGb: 4, tempMb: 16384, controllers: 'SCSI' }),
  rawSku({ name: 'Standard_D2as_v7', family: 'standardDasv7Family', vcpus: 2, memoryGb: 8, gens: 'V2', controllers: 'SCSI,NVMe' }),
  rawSku({ name: 'Standard_D2ads_v7', family: 'standardDadsv7Family', vcpus: 2, memoryGb: 8, tempMb: 76800, gens: 'V2', controllers: 'NVMe', ephemeral: true }),
  rawSku({ name: 'Standard_D2as_v6', family: 'standardDasv6Family', vcpus: 2, memoryGb: 8, gens: 'V2', controllers: 'NVMe' }),
  rawSku({ name: 'Standard_D2ads_v6', family: 'standardDadsv6Family', vcpus: 2, memoryGb: 8, tempMb: 76800, gens: 'V2', controllers: 'NVMe', ephemeral: true }),
  rawSku({ name: 'Standard_E2as_v7', family: 'standardEasv7Family', vcpus: 2, memoryGb: 16, gens: 'V2', controllers: 'NVMe' }),
  rawSku({ name: 'Standard_E2ads_v7', family: 'standardEadsv7Family', vcpus: 2, memoryGb: 16, tempMb: 76800, gens: 'V2', controllers: 'NVMe' }),
  rawSku({ name: 'Standard_F2als_v7', family: 'standardFalsv7Family', vcpus: 2, memoryGb: 4, gens: 'V2', controllers: 'NVMe' }),
  rawSku({ name: 'Standard_D2as_v5', family: 'standardDasv5Family', vcpus: 2, memoryGb: 8, controllers: 'SCSI' }),
];

export function standardEnv(vms: Record<string, unknown>[]): MockArm {
  const byName = new Map(vms.map((v) => [String(v['name']), v]));
  return new MockArm()
    .onList('/providers/Microsoft.Compute/virtualMachines?', vms)
    .onList('/providers/Microsoft.Compute/skus', DEFAULT_SKUS)
    .onList('/providers/Microsoft.Network/networkInterfaces', vms.map((v) => ({
      id: nicId(String(v['name'])),
      properties: { enableAcceleratedNetworking: true, ipConfigurations: [{ properties: {} }] },
    })))
    .onList('/providers/Microsoft.Network/publicIPAddresses', [])
    .onList('/providers/Microsoft.Compute/disks', [])
    .onList('/subscriptions?api-version', [{ subscriptionId: SUB, state: 'Enabled' }])
    .onGet(/virtualMachines\/[^/?]+\?/, (p: string) => byName.get(/virtualMachines\/([^/?]+)/.exec(p)?.[1] ?? '') ?? vms[0]);
}
