import type { SkuInfo, UsageInfo } from '../azure/skus.js';
import type { CheckResult, DiskControllerType, MigrationStrategy, VmInfo } from '../domain/types.js';

export interface ResourceLock {
  name: string;
  level: 'CanNotDelete' | 'ReadOnly';
  scope: string;
}

export interface BackupState {
  protected: boolean;
  lastRecoveryPoint?: string;
  protectionState?: string;
}

/** Everything a check may need; loaded once per VM, target-specific parts swapped per candidate. */
export interface PreCheckContext {
  vm: VmInfo;
  targetSku: string;
  target?: SkuInfo;
  source?: SkuInfo;
  /** Series generation parsed from the target name (7 for *_v7) */
  targetGeneration: number;
  usages?: UsageInfo[];
  locks?: ResourceLock[];
  backup?: BackupState;
  /** DiskControllerTypes feature of the marketplace image, when published */
  imageControllers?: string[];
  availabilitySetVms?: { id: string; name: string }[];
  /** Strategy being evaluated (default inPlace) */
  strategy?: MigrationStrategy;
  /** What could not be loaded (check id or data name -> error) */
  loadErrors: Record<string, string>;
  now: Date;
}

export interface PreCheck {
  id: string;
  run(ctx: PreCheckContext): CheckResult | Promise<CheckResult>;
}

export interface TargetRequirement {
  controller: DiskControllerType;
  /** The controller type has to change (SCSI -> NVMe) which requires deallocation */
  conversion: boolean;
}
