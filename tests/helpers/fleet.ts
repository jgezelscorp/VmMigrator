import { ArmError } from '../../src/azure/arm.js';
import { FakeArm } from './fakeArm.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

export const DEMO_SUBSCRIPTION = '00000000-0000-0000-0000-000000000001';
export const DEMO_LOCATION = 'westeurope';

export interface FleetVmOptions {
  name: string;
  size?: string;
  os?: 'Windows' | 'Linux';
  gen?: 'V1' | 'V2';
  power?: string;
  rg?: string;
  subscription?: string;
  location?: string;
  zones?: string[];
  controller?: string;
  dataDisks?: number;
  availabilitySetId?: string;
  extensions?: { name: string; type: string; publisher?: string; state?: string }[];
  tags?: Record<string, string>;
}

export function buildRawVm(o: FleetVmOptions): Raw {
  const sub = o.subscription ?? DEMO_SUBSCRIPTION;
  const rg = o.rg ?? 'rg-demo';
  const os = o.os ?? 'Linux';
  const id = `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${o.name}`;
  const diskId = (n: string): string => `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/disks/${n}`;
  const power = o.power ?? 'running';
  return {
    id,
    name: o.name,
    location: o.location ?? DEMO_LOCATION,
    tags: o.tags ?? { purpose: 'vmmigrator-demo' },
    ...(o.zones ? { zones: o.zones } : {}),
    resources: (o.extensions ?? []).map((e) => ({
      type: 'Microsoft.Compute/virtualMachines/extensions',
      name: e.name,
      properties: { publisher: e.publisher ?? 'Microsoft.Azure.Monitor', type: e.type, typeHandlerVersion: '1.0', provisioningState: e.state ?? 'Succeeded' },
    })),
    properties: {
      provisioningState: 'Succeeded',
      hardwareProfile: { vmSize: o.size ?? 'Standard_D2s_v3' },
      ...(o.availabilitySetId ? { availabilitySet: { id: o.availabilitySetId } } : {}),
      storageProfile: {
        imageReference:
          os === 'Linux'
            ? { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: 'latest', exactVersion: '24.04.202501010' }
            : { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2022-datacenter-azure-edition', version: 'latest', exactVersion: '20348.1' },
        osDisk: {
          osType: os,
          name: `${o.name}-os`,
          diskSizeGB: 64,
          managedDisk: { id: diskId(`${o.name}-os`), storageAccountType: 'Premium_LRS' },
          caching: 'ReadWrite',
        },
        dataDisks: Array.from({ length: o.dataDisks ?? 0 }, (_, i) => ({
          lun: i,
          name: `${o.name}-data${i}`,
          diskSizeGB: 64,
          managedDisk: { id: diskId(`${o.name}-data${i}`), storageAccountType: 'Premium_LRS' },
        })),
        ...(o.controller ? { diskControllerType: o.controller } : {}),
      },
      networkProfile: {
        networkInterfaces: [{ id: `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/networkInterfaces/${o.name}-nic` }],
      },
      instanceView: {
        hyperVGeneration: o.gen ?? 'V2',
        statuses: [
          { code: 'ProvisioningState/succeeded' },
          { code: `PowerState/${power}`, displayStatus: `VM ${power}` },
        ],
        vmAgent: {
          vmAgentVersion: '2.12.0.2',
          statuses: [{ code: 'ProvisioningState/succeeded', displayStatus: 'Ready', time: new Date().toISOString() }],
        },
        extensions: (o.extensions ?? []).map((e) => ({
          name: e.name,
          statuses: [{ code: `ProvisioningState/${(e.state ?? 'Succeeded').toLowerCase()}` }],
        })),
      },
    },
  };
}

export interface FleetSkuOptions {
  name: string;
  family: string;
  vcpus: number;
  memoryGb: number;
  tempMb?: number;
  gens?: string;
  controllers?: string;
  zones?: string[];
  restricted?: boolean;
}

export function buildRawSku(o: FleetSkuOptions, location = DEMO_LOCATION): Raw {
  const cap = (name: string, value: string): { name: string; value: string } => ({ name, value });
  return {
    resourceType: 'virtualMachines',
    name: o.name,
    family: o.family,
    locations: [location],
    locationInfo: [{ location, zones: o.zones ?? ['1', '2', '3'] }],
    capabilities: [
      cap('vCPUs', String(o.vcpus)),
      cap('MemoryGB', String(o.memoryGb)),
      cap('MaxResourceVolumeMB', String(o.tempMb ?? 0)),
      cap('HyperVGenerations', o.gens ?? 'V1,V2'),
      cap('DiskControllerTypes', o.controllers ?? 'SCSI'),
      cap('AcceleratedNetworkingEnabled', 'True'),
      cap('PremiumIO', 'True'),
      cap('EphemeralOSDiskSupported', 'False'),
      cap('MaxDataDiskCount', '8'),
    ],
    restrictions: o.restricted ? [{ type: 'Location', reasonCode: 'NotAvailableForSubscription', restrictionInfo: { locations: [location], zones: [] } }] : [],
  };
}

export const DEMO_SKUS: Raw[] = [
  buildRawSku({ name: 'Standard_D2s_v3', family: 'standardDSv3Family', vcpus: 2, memoryGb: 8, tempMb: 16384 }),
  buildRawSku({ name: 'Standard_E2s_v3', family: 'standardESv3Family', vcpus: 2, memoryGb: 16, tempMb: 32768 }),
  buildRawSku({ name: 'Standard_DS2_v2', family: 'standardDSv2Family', vcpus: 2, memoryGb: 7, tempMb: 14336 }),
  buildRawSku({ name: 'Standard_D2as_v7', family: 'standardDasv7Family', vcpus: 2, memoryGb: 8, gens: 'V2', controllers: 'NVMe' }),
  buildRawSku({ name: 'Standard_D2ads_v7', family: 'standardDadsv7Family', vcpus: 2, memoryGb: 8, tempMb: 76800, gens: 'V2', controllers: 'NVMe' }),
  buildRawSku({ name: 'Standard_D2as_v6', family: 'standardDasv6Family', vcpus: 2, memoryGb: 8, gens: 'V2', controllers: 'NVMe' }),
  buildRawSku({ name: 'Standard_D2ads_v6', family: 'standardDadsv6Family', vcpus: 2, memoryGb: 8, tempMb: 76800, gens: 'V2', controllers: 'NVMe' }),
  buildRawSku({ name: 'Standard_E2as_v7', family: 'standardEasv7Family', vcpus: 2, memoryGb: 16, gens: 'V2', controllers: 'NVMe' }),
  buildRawSku({ name: 'Standard_E2ads_v7', family: 'standardEadsv7Family', vcpus: 2, memoryGb: 16, tempMb: 76800, gens: 'V2', controllers: 'NVMe' }),
  buildRawSku({ name: 'Standard_D2as_v5', family: 'standardDasv5Family', vcpus: 2, memoryGb: 8 }),
];

const AMA = { name: 'AzureMonitorAgent', type: 'AzureMonitorLinuxAgent' };

/** Demo fleet mirroring demo/ (retiring series). `lnx-fail-sim` fails to start on any new size, to demo rollback. */
export function createDemoFakeArm(opts: { latencyMs?: number } = {}): FakeArm {
  const avs = `/subscriptions/${DEMO_SUBSCRIPTION}/resourceGroups/rg-demo/providers/Microsoft.Compute/availabilitySets/avs1`;
  const arm = new FakeArm({
    subscriptions: [{ subscriptionId: DEMO_SUBSCRIPTION, displayName: 'VmMigrator Demo (mock)' }],
    skus: DEMO_SKUS,
    latencyMs: opts.latencyMs ?? 0,
    vms: [
      buildRawVm({ name: 'lnx-dsv3-g2-data', size: 'Standard_D2s_v3', dataDisks: 2, extensions: [AMA] }),
      buildRawVm({ name: 'win-dsv3-g2', size: 'Standard_D2s_v3', os: 'Windows' }),
      buildRawVm({ name: 'lnx-dsv3-g1', size: 'Standard_D2s_v3', gen: 'V1' }),
      buildRawVm({ name: 'lnx-dsv2-g2-avs1', size: 'Standard_DS2_v2', power: 'deallocated', availabilitySetId: avs }),
      buildRawVm({ name: 'lnx-fail-sim', size: 'Standard_E2s_v3' }),
    ],
  });
  arm.inject({
    method: 'POST',
    match: /virtualMachines\/lnx-fail-sim\/start/i,
    when: (vm) => vm?.properties?.hardwareProfile?.vmSize !== 'Standard_E2s_v3',
    error: new ArmError('Allocation failed: no capacity for the requested size (simulated).', 409, 'AllocationFailed'),
  });
  return arm;
}
