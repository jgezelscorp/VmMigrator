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
  | 'SnapshotTaken'
  | 'Deallocated'
  | 'Updated'
  | 'Started'
  | 'PostChecked'
  | 'Done';

export type MigrationState = MigrationStep | 'RollingBack' | 'Restored' | 'Failed';

export interface PlannedAction {
  step: MigrationStep;
  description: string;
  /** ARM call that would be made, for dry-run output */
  method?: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';
  url?: string;
}

export interface MigrationPlan {
  vmId: string;
  sourceSku: string;
  targetSku: string;
  targetDiskController?: DiskControllerType;
  dryRun: boolean;
  actions: PlannedAction[];
}

export interface PostCheckResult {
  vmId: string;
  overall: CheckStatus;
  checks: CheckResult[];
  ranAt: string;
}

export interface MigrationJob {
  id: string;
  plan: MigrationPlan;
  state: MigrationState;
  completedSteps: MigrationStep[];
  error?: string;
  startedAt: string;
  updatedAt: string;
}
