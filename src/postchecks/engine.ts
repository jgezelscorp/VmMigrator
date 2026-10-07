import type { ArmClient } from '../azure/arm.js';
import { COMPUTE_API } from '../discovery/discovery.js';
import type { MigrationJob, PostCheckItem, PostCheckResult, PostCheckStatus, VmInfo } from '../domain/types.js';

export interface PostCheckDeps {
  arm: ArmClient;
  /** Reload the VM (instance view included) */
  getVm(vmId: string): Promise<VmInfo>;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
  /** How long to wait for the VM agent heartbeat after boot (default 3 min) */
  agentWaitMs?: number;
  agentPollMs?: number;
  /** Heartbeats older than this count as stale (default 10 min) */
  maxHeartbeatAgeMs?: number;
}

export interface PostCheckOptions {
  /** Run the guest probe through the run-command API */
  guestProbe?: boolean;
}

const RANK: Record<PostCheckStatus, number> = { PASS: 0, WARN: 1, FAIL: 2 };
export const worstPostStatus = (checks: PostCheckItem[]): PostCheckStatus =>
  checks.reduce<PostCheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'PASS');

const item = (checkId: string, status: PostCheckStatus, message: string, remediation?: string): PostCheckItem => ({
  checkId,
  status,
  message,
  ...(remediation ? { remediation } : {}),
});

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sameSet = (a: number[], b: number[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export const LINUX_PROBE = [
  'set +e',
  'echo "VMM_ROOT=$(findmnt -n -o SOURCE /)"',
  'echo "VMM_NVME_DEVICES=$(ls /dev/nvme*n* 2>/dev/null | wc -l)"',
  'echo "VMM_FSTAB_DEVICE_PATHS=$(awk \'$1 ~ /^\\/dev\\/(sd|nvme)/ {printf "%s ", $1}\' /etc/fstab)"',
  'if mount -a --fake >/dev/null 2>&1; then echo VMM_FSTAB=OK; else echo VMM_FSTAB=FAIL; fi',
  'echo VMM_PROBE_DONE',
];

export const WINDOWS_PROBE = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Write-Output ("VMM_DISKS=" + @(Get-Disk).Count)',
  'Write-Output ("VMM_OFFLINE=" + @(Get-Disk | Where-Object { $_.IsOffline }).Count)',
  'Write-Output ("VMM_DRIVES=" + ((Get-Volume | Where-Object DriveLetter | ForEach-Object { $_.DriveLetter }) -join ","))',
  'Write-Output VMM_PROBE_DONE',
];

function parseProbe(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^(VMM_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) out[m[1]] = (m[2] ?? '').trim();
  }
  if (/VMM_PROBE_DONE/.test(output)) out['VMM_PROBE_DONE'] = '1';
  return out;
}

async function guestProbe(deps: PostCheckDeps, vm: VmInfo): Promise<PostCheckItem> {
  const windows = vm.osType === 'Windows';
  try {
    const res = await deps.arm.send<{ value?: { code?: string; message?: string }[] } | undefined>('POST', `${vm.id}/runCommand?api-version=${COMPUTE_API}`, {
      commandId: windows ? 'RunPowerShellScript' : 'RunShellScript',
      script: windows ? WINDOWS_PROBE : LINUX_PROBE,
    });
    const text = (res?.value ?? []).map((v) => v.message ?? '').join('\n');
    const kv = parseProbe(text);
    if (!kv['VMM_PROBE_DONE']) return item('guest-probe', 'WARN', 'The guest probe returned no usable output.', 'Check the VM agent and run the probe manually.');
    if (windows) {
      const offline = Number(kv['VMM_OFFLINE'] ?? 0);
      return offline > 0
        ? item('guest-probe', 'WARN', `${offline} disk(s) are offline in the guest (drive letters: ${kv['VMM_DRIVES'] || 'none'}).`, 'Bring disks online (Disk Management / Set-Disk -IsOffline $false) and verify drive letters.')
        : item('guest-probe', 'PASS', `Guest sees ${kv['VMM_DISKS'] ?? '?'} disk(s); drive letters: ${kv['VMM_DRIVES'] || 'none'}.`);
    }
    if (kv['VMM_FSTAB'] === 'FAIL') {
      return item('guest-probe', 'FAIL', 'mount -a --fake failed: /etc/fstab has entries that will not mount.', 'Fix /etc/fstab (use UUID= or LABEL=, add nofail) before the next reboot, or roll back.');
    }
    if (kv['VMM_FSTAB_DEVICE_PATHS']) {
      return item('guest-probe', 'WARN', `fstab references device paths (${kv['VMM_FSTAB_DEVICE_PATHS']}) that can change with NVMe.`, 'Switch fstab entries to UUID= and add nofail.');
    }
    return item('guest-probe', 'PASS', `Guest healthy: root ${kv['VMM_ROOT'] ?? '?'}, ${kv['VMM_NVME_DEVICES'] ?? '0'} NVMe device(s), fstab mounts cleanly.`);
  } catch (e) {
    return item('guest-probe', 'WARN', `Guest probe could not run: ${errText(e)}`, 'Ensure the VM agent is running; run the checks manually.');
  }
}

/** Verifies a migrated VM against what the job intended. Read-only except for the optional run-command probe. */
export async function runPostChecks(deps: PostCheckDeps, job: MigrationJob, opts: PostCheckOptions = {}): Promise<PostCheckResult> {
  const now = deps.now ?? ((): Date => new Date());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const plan = job.plan;
  const orig = job.original;
  const wantRunning = !orig || orig.powerState === 'running' || orig.powerState === 'starting';
  const checks: PostCheckItem[] = [];

  let vm = await deps.getVm(plan.vmId);

  checks.push(
    vm.provisioningState === 'Succeeded'
      ? item('provisioning', 'PASS', 'Provisioning state is Succeeded.')
      : vm.provisioningState === 'Failed'
        ? item('provisioning', 'FAIL', 'VM provisioning failed.', 'Inspect the activity log; consider rolling back.')
        : item('provisioning', 'WARN', `Provisioning state is ${vm.provisioningState ?? 'unknown'}.`),
  );

  const expectedPower = wantRunning ? 'running' : 'deallocated';
  checks.push(
    vm.powerState === expectedPower
      ? item('power-state', 'PASS', `VM is ${vm.powerState}.`)
      : item('power-state', 'FAIL', `VM is ${vm.powerState}, expected ${expectedPower}.`, wantRunning ? 'Start the VM or roll back.' : undefined),
  );

  checks.push(
    vm.vmSize.toLowerCase() === plan.targetSku.toLowerCase()
      ? item('vm-size', 'PASS', `Size is ${vm.vmSize}.`)
      : item('vm-size', 'FAIL', `Size is ${vm.vmSize}, expected ${plan.targetSku}.`, 'The resize did not apply; retry or roll back.'),
  );

  const ctl = vm.diskControllerType ?? 'SCSI';
  const wantCtl = plan.targetDiskController ?? ctl;
  checks.push(
    ctl === wantCtl
      ? item('disk-controller', 'PASS', `Disk controller is ${ctl}.`)
      : item('disk-controller', 'FAIL', `Disk controller is ${ctl}, expected ${wantCtl}.`, 'Deallocate and re-apply diskControllerType, or roll back.'),
  );

  if (wantRunning && vm.powerState === 'running') {
    const maxAge = deps.maxHeartbeatAgeMs ?? 10 * 60_000;
    const pollMs = deps.agentPollMs ?? 10_000;
    const attempts = Math.max(1, Math.ceil((deps.agentWaitMs ?? 3 * 60_000) / pollMs));
    const ready = (v: VmInfo): boolean => {
      const hb = v.agent?.lastHeartbeat ? Date.parse(v.agent.lastHeartbeat) : NaN;
      return /^ready$/i.test(v.agent?.status ?? '') && (Number.isNaN(hb) || now().getTime() - hb <= maxAge);
    };
    for (let i = 0; i < attempts && !ready(vm); i++) {
      await sleep(pollMs);
      vm = await deps.getVm(plan.vmId);
    }
    checks.push(
      ready(vm)
        ? item('vm-agent', 'PASS', `VM agent ${vm.agent?.version ?? ''} is Ready (heartbeat ${vm.agent?.lastHeartbeat ?? 'n/a'}).`.replace('  ', ' '))
        : !vm.agent
          ? item('vm-agent', 'WARN', 'No VM agent status reported.', 'Verify the agent is installed and running in the guest.')
          : item('vm-agent', 'FAIL', `VM agent status is "${vm.agent.status ?? 'unknown'}" (last heartbeat ${vm.agent.lastHeartbeat ?? 'never'}).`, 'The guest may not have booted correctly (NVMe driver?). Check boot diagnostics or roll back.'),
    );
  } else {
    checks.push(item('vm-agent', 'PASS', 'Not applicable: the VM is not running.'));
  }

  try {
    const exts = await deps.arm.list<{ name: string; properties?: { provisioningState?: string } }>(`${plan.vmId}/extensions?api-version=${COMPUTE_API}`);
    const ivStatus = new Map(
      (vm.extensions ?? []).map((e) => [e.name.toLowerCase(), e.statusCode ?? ''] as const),
    );
    const failed = exts.filter((e) => /^failed$/i.test(e.properties?.provisioningState ?? '') || /\/failed$/i.test(ivStatus.get(e.name.toLowerCase()) ?? ''));
    const transitioning = exts.filter((e) => /^(creating|updating)$/i.test(e.properties?.provisioningState ?? ''));
    checks.push(
      failed.length
        ? item('extensions', 'FAIL', `Extension(s) in failed state: ${failed.map((e) => e.name).join(', ')}.`, 'Re-apply the extension or review its logs; roll back if it is critical.')
        : transitioning.length
          ? item('extensions', 'WARN', `Extension(s) still provisioning: ${transitioning.map((e) => e.name).join(', ')}.`)
          : item('extensions', 'PASS', exts.length ? `${exts.length} extension(s) provisioned successfully.` : 'No extensions installed.'),
    );
  } catch (e) {
    checks.push(item('extensions', 'WARN', `Extensions could not be read: ${errText(e)}`));
  }

  checks.push(
    !vm.nics?.length
      ? item('accelerated-networking', 'WARN', 'NIC details unavailable.')
      : vm.nics.every((n) => n.acceleratedNetworking)
        ? item('accelerated-networking', 'PASS', 'Accelerated networking is enabled on all NICs.')
        : item('accelerated-networking', 'WARN', 'Accelerated networking is not enabled on every NIC.', 'Enable it on the NIC (requires deallocation) for full v6/v7 network performance.'),
  );

  const luns = (vm.dataDisks ?? []).map((d) => d.lun ?? 0);
  if (!vm.osDisk) {
    checks.push(item('disks', 'FAIL', 'OS disk is missing from the VM model.', 'Roll back and recreate from snapshots.'));
  } else if (orig?.dataDiskLuns && !sameSet(orig.dataDiskLuns, luns)) {
    checks.push(item('disks', 'FAIL', `Data disk LUNs changed: before [${orig.dataDiskLuns.join(',')}], now [${luns.join(',')}].`, 'Reattach the missing disks or roll back.'));
  } else {
    checks.push(item('disks', 'PASS', `OS disk and ${luns.length} data disk(s) attached${luns.length ? ` (LUN ${luns.join(',')})` : ''}.`));
  }

  const tagChanges = orig?.tags ? Object.keys(orig.tags).filter((k) => vm.tags[k] !== orig.tags?.[k]) : [];
  const dynamicIps = (orig?.publicIps ?? []).filter((p) => /dynamic/i.test(p.allocationMethod ?? ''));
  const nowIps = new Set((vm.nics ?? []).flatMap((n) => n.publicIps.map((p) => p.id.toLowerCase())));
  const lostIps = (orig?.publicIps ?? []).filter((p) => !nowIps.has(p.id.toLowerCase()));
  const notes: string[] = [];
  if (tagChanges.length) notes.push(`tags changed: ${tagChanges.join(', ')}`);
  if (lostIps.length) notes.push(`public IP association lost: ${lostIps.map((p) => p.id.split('/').pop()).join(', ')}`);
  if (dynamicIps.length) notes.push('dynamic public IP address may have changed after deallocation');
  checks.push(
    notes.length
      ? item('tags-and-ips', 'WARN', `Changes detected: ${notes.join('; ')}.`, 'Review tags and IP addresses; update DNS or firewall rules if an IP changed.')
      : item('tags-and-ips', 'PASS', 'Tags and public IP associations are unchanged.'),
  );

  if (orig?.backupProtected !== undefined) {
    try {
      const res = await deps.arm.send<{ data?: { protectionState?: string }[] }>('POST', '/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01', {
        subscriptions: [vm.subscriptionId],
        options: { resultFormat: 'objectArray' },
        query: `RecoveryServicesResources | where type =~ 'microsoft.recoveryservices/vaults/backupfabrics/protectioncontainers/protecteditems' | where tolower(tostring(properties.sourceResourceId)) == '${vm.id.toLowerCase()}' | project protectionState = tostring(properties.protectionState)`,
      });
      const protectedNow = (res?.data?.length ?? 0) > 0;
      checks.push(
        orig.backupProtected && !protectedNow
          ? item('backup', 'WARN', 'Azure Backup protection was found before the migration but not now.', 'Re-enable backup protection for the VM.')
          : item('backup', 'PASS', orig.backupProtected ? 'Azure Backup protection intact.' : 'VM was not protected by Azure Backup before; unchanged.'),
      );
    } catch (e) {
      checks.push(item('backup', 'WARN', `Backup state could not be read: ${errText(e)}`));
    }
  }

  if (opts.guestProbe ?? job.options?.guestProbe) {
    checks.push(vm.powerState === 'running' ? await guestProbe(deps, vm) : item('guest-probe', 'WARN', 'Guest probe skipped: the VM is not running.'));
  }

  const overall = worstPostStatus(checks);
  return {
    vmId: plan.vmId,
    overall,
    checks,
    ranAt: now().toISOString(),
    ...(overall === 'FAIL'
      ? { recommendation: `Roll back to ${orig?.vmSize ?? plan.sourceSku} (POST /api/migrations/${job.id}/rollback) unless the failed checks can be fixed in place.` }
      : {}),
  };
}

/** Adapter for MigrationDeps.postCheck. */
export function createPostCheckHook(deps: PostCheckDeps): (job: MigrationJob) => Promise<PostCheckResult> {
  return (job) => runPostChecks(deps, job);
}
