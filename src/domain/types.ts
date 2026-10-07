export type PowerState = 'running' | 'deallocated' | 'stopped' | 'starting' | 'stopping' | 'unknown';

export type DiskControllerType = 'SCSI' | 'NVMe';

export type HyperVGeneration = 'V1' | 'V2';

export interface VmInfo {
  /** Full ARM resource id */
  id: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  zones: string[];
  /** Current size, e.g. Standard_D2s_v3 */
  vmSize: string;
  osType: 'Windows' | 'Linux';
  hyperVGeneration?: HyperVGeneration;
  diskControllerType?: DiskControllerType;
  powerState: PowerState;
  availabilitySetId?: string;
  proximityPlacementGroupId?: string;
  acceleratedNetworking?: boolean;
  tags: Record<string, string>;
  /** Set when the size belongs to a series in the retirement catalog */
  retiringSeries?: string;
  /** ISO date (yyyy-mm-dd) */
  retirementDate?: string;
  /** Ranked migration targets from data/sku-mapping.json (not yet validated against live availability) */
  candidateTargets?: TargetCandidate[];
  provisioningState?: string;
  priority?: 'Regular' | 'Spot' | 'Low';
  securityType?: string;
  imageReference?: ImageReference;
  osDisk?: VmDisk;
  dataDisks?: VmDisk[];
  /** True when the OS disk is ephemeral (diffDiskSettings) */
  ephemeralOsDisk?: boolean;
  encryption?: VmEncryption;
  extensions?: VmExtension[];
  nics?: VmNic[];
  agent?: { version?: string; status?: string; lastHeartbeat?: string };
  capacityReservationGroupId?: string;
  dedicatedHostId?: string;
  virtualMachineScaleSetId?: string;
}

export interface ImageReference {
  publisher?: string;
  offer?: string;
  sku?: string;
  version?: string;
  /** Compute Gallery / custom image resource id */
  id?: string;
}

export interface VmDisk {
  name: string;
  id?: string;
  lun?: number;
  sizeGb?: number;
  /** Managed disk SKU, e.g. Premium_LRS */
  storageAccountType?: string;
  caching?: string;
  /** maxShares > 1 */
  shared?: boolean;
}

export interface VmEncryption {
  /** Azure Disk Encryption extension / settings present */
  ade: boolean;
  encryptionAtHost: boolean;
  diskEncryptionSetId?: string;
}

export interface VmExtension {
  name: string;
  publisher?: string;
  type?: string;
  typeHandlerVersion?: string;
  provisioningState?: string;
  /** Instance-view status code, e.g. ProvisioningState/succeeded */
  statusCode?: string;
}

export interface VmNic {
  id: string;
  acceleratedNetworking: boolean;
  publicIps: { id: string; allocationMethod?: string; sku?: string }[];
}

export type CheckStatus = 'PASS' | 'WARN' | 'BLOCK';

/** inPlace = resize the existing VM; rebuild = recreate the VM definition (opt-in, more invasive) */
export type MigrationStrategy = 'inPlace' | 'rebuild';

/** recreate = new disks + new VM (Windows temp-disk source -> diskless target); gen1-upgrade = Gen1 -> Trusted launch/Gen2 upgrade, then resize */
export type RebuildKind = 'recreate' | 'gen1-upgrade';

export interface CheckResult {
  /** Stable check id, e.g. "sku-availability" */
  checkId: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface PreCheckResult {
  vmId: string;
  targetSku: string;
  /** Worst status across checks (BLOCK > WARN > PASS) */
  overall: CheckStatus;
  checks: CheckResult[];
  ranAt: string;
  sourceSku?: string;
  /** Controller the migration will set (NVMe) or keep (SCSI) on the target size */
  targetDiskController?: DiskControllerType;
  /** 'auto' when the engine picked the target from the ranked candidates */
  targetSelection?: 'explicit' | 'auto';
  /** Candidates evaluated during auto selection, in rank order */
  candidatesEvaluated?: { sku: string; overall: CheckStatus }[];
  /** Strategy the checks were evaluated for (default inPlace) */
  strategy?: MigrationStrategy;
  /** True when in-place resize cannot reach the preferred v6/v7 target but the opt-in rebuild strategy can */
  rebuildAvailable?: boolean;
  rebuildKind?: RebuildKind;
}

export interface TargetCandidate {
  sku: string;
  /** Series generation, e.g. 7 for Dsv7 */
  generation: number;
  rank: number;
  vendor?: 'AMD' | 'Intel';
  /** Target has a local temp disk (the "d" sizes) */
  tempDisk?: boolean;
  /** Only offered as a safe fallback (e.g. v5 for Gen1 VMs) */
  optional?: boolean;
}

export type MigrationStep =
  | 'Validated'
  | 'Prepared'
  | 'SnapshotTaken'
  | 'Deallocated'
  | 'Updated'
  | 'Rebuilt'
  | 'Started'
  | 'PostChecked'
  | 'Done';

/** Queued = created but not started; Done/Failed/Restored are terminal. */
export type MigrationState = MigrationStep | 'Queued' | 'RollingBack' | 'Restored' | 'Failed';

export interface PlannedAction {
  step: MigrationStep;
  description: string;
  /** ARM call that would be made, for dry-run output */
  method?: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';
  url?: string;
  body?: unknown;
}

export interface MigrationPlan {
  vmId: string;
  vmName?: string;
  availabilitySetId?: string;
  sourceSku: string;
  targetSku: string;
  sourceDiskController?: DiskControllerType;
  targetDiskController?: DiskControllerType;
  strategy?: MigrationStrategy;
  rebuildKind?: RebuildKind;
  dryRun: boolean;
  actions: PlannedAction[];
  /** Pre-check outcome the plan is based on */
  preCheck?: PreCheckResult;
}

export type PostCheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface PostCheckItem {
  checkId: string;
  status: PostCheckStatus;
  message: string;
  remediation?: string;
}

export interface PostCheckResult {
  vmId: string;
  overall: PostCheckStatus;
  checks: PostCheckItem[];
  ranAt: string;
  /** Set when overall is FAIL: advises rolling back */
  recommendation?: string;
}

export interface SnapshotRef {
  diskId: string;
  diskName: string;
  snapshotId: string;
  snapshotName: string;
  role: 'os' | 'data';
  lun?: number;
}

export interface OriginalVmModel {
  vmSize: string;
  diskControllerType: DiskControllerType;
  powerState: PowerState;
  /** Baseline used by post-checks to detect changes */
  dataDiskLuns?: number[];
  tags?: Record<string, string>;
  publicIps?: { id: string; allocationMethod?: string }[];
  backupProtected?: boolean;
  /** Rebuild strategy only: everything needed to recreate the original VM */
  rebuild?: RebuildState;
}

export interface RebuildDisk {
  role: 'os' | 'data';
  lun?: number;
  /** Disk attached to the original VM (kept until cleanup) */
  originalDiskId: string;
  originalDiskName: string;
  snapshotId?: string;
  /** Disk created from the snapshot for the rebuilt VM */
  newDiskId?: string;
  newDiskName?: string;
}

export interface RebuildState {
  kind: RebuildKind;
  /** Raw ARM VM definition captured before any change (contains no protected settings) */
  definition: unknown;
  /** Raw ARM extension resources captured before any change */
  extensions: unknown[];
  disks: RebuildDisk[];
  /** Gen1 upgrade was started: the original disks may be Gen2 now, so rollback recreates disks from snapshots */
  upgradeStarted?: boolean;
  /** The original VM was deleted (the VM that exists now, if any, is the rebuilt one) */
  vmDeleted?: boolean;
  vmCreated?: boolean;
  originalDisksDeleted?: boolean;
  pagefile?: string;
}

export interface JobEvent {
  at: string;
  level: 'info' | 'warn' | 'error';
  step?: MigrationStep | 'Rollback' | 'Cleanup';
  message: string;
}

export interface MigrationJob {
  id: string;
  plan: MigrationPlan;
  state: MigrationState;
  completedSteps: MigrationStep[];
  error?: string;
  startedAt: string;
  updatedAt: string;
  vmName?: string;
  /** Model captured before the first mutation; used by rollback */
  original?: OriginalVmModel;
  snapshots?: SnapshotRef[];
  /** True once the engine began changing the VM (deallocation); failure then triggers rollback */
  mutated?: boolean;
  options?: MigrationJobOptions;
  events?: JobEvent[];
  postCheck?: PostCheckResult;
  rollback?: { reason: string; at: string; trigger: 'automatic' | 'manual'; succeeded: boolean };
  snapshotsCleaned?: boolean;
}

export interface MigrationJobOptions {
  /** Delete snapshots after a successful migration (default: keep) */
  cleanupSnapshots?: boolean;
  /** Skip snapshots (not recommended) */
  skipSnapshots?: boolean;
  /** ISO timestamps; migration is refused outside the window */
  maintenanceWindow?: { start: string; end: string };
  /** Run the optional guest probe through run-command in post-checks */
  guestProbe?: boolean;
  /** Roll back automatically when the post-check overall result is FAIL (default: only recommend) */
  autoRollbackOnPostCheckFail?: boolean;
  /** 'rebuild' recreates the VM (downtime, new VM resource); requires confirmRebuild for a real run */
  strategy?: MigrationStrategy;
  /** Explicit acknowledgement of downtime and VM recreation */
  confirmRebuild?: boolean;
  /** Windows rebuild: move the pagefile from the temp disk to C: via run-command first (default true) */
  movePagefile?: boolean;
}

