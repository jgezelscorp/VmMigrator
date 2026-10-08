import type { DiskControllerType } from '../domain/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ADE_EXTENSION_TYPES = /^AzureDiskEncryption(ForLinux)?$/i;

/** Name of the disk created from a snapshot for the rebuilt VM (managed disk names are limited to 80 chars). */
export function rebuildDiskName(original: string, jobId: string, tag = 'rb'): string {
  const suffix = `-${tag}-${jobId.slice(0, 8)}`;
  return `${original.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80 - suffix.length)}${suffix}`;
}

export function diskPath(subscriptionId: string, resourceGroup: string, name: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/disks/${name}`;
}

/** Body of the disk created from an incremental snapshot, mirroring the original disk's relevant settings. */
export function newDiskBody(opts: {
  location: string;
  zones?: string[];
  snapshotId: string;
  original?: Raw;
  sku?: string;
  osType?: string;
  tags?: Record<string, string>;
}): Raw {
  const o = opts.original ?? {};
  const p = o.properties ?? {};
  const sku = o.sku?.name ?? opts.sku;
  const premiumV2OrUltra = /^(ultra|premiumv2)/i.test(sku ?? '');
  const keep: Raw = {};
  for (const k of ['hyperVGeneration', 'networkAccessPolicy', 'publicNetworkAccess', 'supportedCapabilities', 'encryption', 'burstingEnabled', 'diskSizeGB']) {
    if (p[k] !== undefined) keep[k] = clone(p[k]);
  }
  if (premiumV2OrUltra) {
    for (const k of ['diskIOPSReadWrite', 'diskMBpsReadWrite']) if (p[k] !== undefined) keep[k] = p[k];
  }
  const zones = o.zones ?? opts.zones;
  return {
    location: opts.location,
    ...(sku ? { sku: { name: sku } } : {}),
    ...(zones?.length ? { zones } : {}),
    tags: { ...(o.tags ?? {}), ...(opts.tags ?? {}), purpose: 'vmmigrator-rebuild' },
    properties: {
      ...keep,
      ...(p.osType ?? opts.osType ? { osType: p.osType ?? opts.osType } : {}),
      creationData: { createOption: 'Copy', sourceResourceId: opts.snapshotId },
    },
  };
}

export interface AttachedDisk {
  id: string;
  name: string;
}

export interface RecreateVmInput {
  definition: Raw;
  vmSize: string;
  controller: DiskControllerType;
  os: AttachedDisk;
  data: Map<number, AttachedDisk>;
}

/**
 * ARM body that recreates a VM from its captured definition with attached disks: same NICs (so private/public IPs),
 * tags, zone, availability set, identity and settings; only size, disk controller and the disks change.
 */
export function recreateVmBody({ definition: def, vmSize, controller, os, data }: RecreateVmInput): Raw {
  const props: Raw = clone(def.properties ?? {});
  for (const k of ['provisioningState', 'vmId', 'instanceView', 'timeCreated', 'osProfile']) delete props[k];
  const sp = props.storageProfile ?? {};
  const osd = sp.osDisk ?? {};
  props.storageProfile = {
    osDisk: {
      osType: osd.osType,
      name: os.name,
      createOption: 'Attach',
      ...(osd.caching ? { caching: osd.caching } : {}),
      ...(osd.writeAcceleratorEnabled !== undefined ? { writeAcceleratorEnabled: osd.writeAcceleratorEnabled } : {}),
      ...(osd.deleteOption ? { deleteOption: osd.deleteOption } : {}),
      managedDisk: { id: os.id },
    },
    dataDisks: (sp.dataDisks ?? []).map((d: Raw) => {
      const a = data.get(d.lun ?? 0);
      return {
        lun: d.lun ?? 0,
        name: a?.name ?? d.name,
        createOption: 'Attach',
        ...(d.caching ? { caching: d.caching } : {}),
        ...(d.writeAcceleratorEnabled !== undefined ? { writeAcceleratorEnabled: d.writeAcceleratorEnabled } : {}),
        ...(d.deleteOption ? { deleteOption: d.deleteOption } : {}),
        ...(d.diskSizeGB ? { diskSizeGB: d.diskSizeGB } : {}),
        managedDisk: { id: a?.id ?? d.managedDisk?.id },
      };
    }),
    diskControllerType: controller,
  };
  props.hardwareProfile = { ...(props.hardwareProfile ?? {}), vmSize };
  const identity = def.identity
    ? {
        type: def.identity.type,
        ...(def.identity.userAssignedIdentities ? { userAssignedIdentities: Object.fromEntries(Object.keys(def.identity.userAssignedIdentities).map((k) => [k, {}])) } : {}),
      }
    : undefined;
  return {
    location: def.location,
    ...(def.tags ? { tags: def.tags } : {}),
    ...(def.zones ? { zones: def.zones } : {}),
    ...(def.plan ? { plan: def.plan } : {}),
    ...(identity ? { identity } : {}),
    properties: props,
  };
}

/** Body to flip every disk/NIC deleteOption to Detach so deleting the VM definition keeps them. */
export function detachBody(def: Raw): Raw | undefined {
  const sp = def.properties?.storageProfile ?? {};
  const nics: Raw[] = def.properties?.networkProfile?.networkInterfaces ?? [];
  const risky = sp.osDisk?.deleteOption === 'Delete' || (sp.dataDisks ?? []).some((d: Raw) => d.deleteOption === 'Delete') || nics.some((n) => n.properties?.deleteOption === 'Delete');
  if (!risky) return undefined;
  return {
    properties: {
      storageProfile: {
        osDisk: { ...sp.osDisk, deleteOption: 'Detach' },
        dataDisks: (sp.dataDisks ?? []).map((d: Raw) => ({ ...d, deleteOption: 'Detach' })),
      },
      networkProfile: {
        networkInterfaces: nics.map((n) => ({ ...n, properties: { ...(n.properties ?? {}), deleteOption: 'Detach' } })),
      },
    },
  };
}

/** One-shot password/SSH reset extensions: their protected settings are unreadable, so recreating them fails. */
const VMACCESS_TYPES = /^(VMAccessAgent|VMAccessForLinux)$/i;

/** Extension resources that can be recreated (ADE cannot, and protected settings are never readable). */
export function extensionBodies(extensions: Raw[], location: string): { name: string; body: Raw }[] {
  return extensions
    .filter((e) => e?.name && e.properties?.type && !ADE_EXTENSION_TYPES.test(e.properties.type) && !VMACCESS_TYPES.test(e.properties.type))
    .map((e) => {
      const p = e.properties;
      return {
        name: String(e.name),
        body: {
          location,
          properties: {
            publisher: p.publisher,
            type: p.type,
            typeHandlerVersion: p.typeHandlerVersion,
            ...(p.autoUpgradeMinorVersion !== undefined ? { autoUpgradeMinorVersion: p.autoUpgradeMinorVersion } : {}),
            ...(p.enableAutomaticUpgrade !== undefined ? { enableAutomaticUpgrade: p.enableAutomaticUpgrade } : {}),
            ...(p.settings ? { settings: p.settings } : {}),
            ...(p.suppressFailures !== undefined ? { suppressFailures: p.suppressFailures } : {}),
          },
        },
      };
    });
}

/** Body of the Gen1 -> Trusted launch (Gen2) upgrade PATCH (VM must be deallocated). */
export const trustedLaunchBody = {
  properties: { securityProfile: { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } } },
};

/** Moves the pagefile off the temp (resource) disk: system-managed on the system drive. Takes effect on the next boot. */
export const PAGEFILE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$key = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management"',
  'Write-Output ("VMM_PAGEFILE_BEFORE=" + ((Get-ItemProperty $key).PagingFiles -join ";"))',
  '$cs = Get-CimInstance Win32_ComputerSystem',
  'if (-not $cs.AutomaticManagedPagefile) { Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $true } }',
  'Get-CimInstance Win32_PageFileSetting | Remove-CimInstance',
  '$now = (Get-ItemProperty $key).PagingFiles',
  'if (@($now | Where-Object { $_ -match "^[dDeEfF]:" }).Count -gt 0) { Set-ItemProperty -Path $key -Name PagingFiles -Value "?:\\pagefile.sys" -Type MultiString }',
  'Write-Output ("VMM_PAGEFILE_AFTER=" + ((Get-ItemProperty $key).PagingFiles -join ";"))',
  'Write-Output VMM_PROBE_DONE',
];
