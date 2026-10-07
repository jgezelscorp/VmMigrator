import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { MigrationJob } from '../domain/types.js';

export interface JobStore {
  save(job: MigrationJob): void;
  load(id: string): MigrationJob | undefined;
  list(): MigrationJob[];
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, string>();

  save(job: MigrationJob): void {
    this.jobs.set(job.id, JSON.stringify(job));
  }

  load(id: string): MigrationJob | undefined {
    const raw = this.jobs.get(id);
    return raw ? (JSON.parse(raw) as MigrationJob) : undefined;
  }

  list(): MigrationJob[] {
    return [...this.jobs.values()].map((r) => JSON.parse(r) as MigrationJob);
  }
}

/** One JSON file per job; written atomically so a crash never leaves a half-written record. */
export class FileJobStore implements JobStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid job id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  save(job: MigrationJob): void {
    const target = this.file(job.id);
    const partial = `${target}.partial`;
    writeFileSync(partial, JSON.stringify(job, null, 2), 'utf8');
    renameSync(partial, target);
  }

  load(id: string): MigrationJob | undefined {
    if (!SAFE_ID.test(id)) return undefined;
    const file = this.file(id);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as MigrationJob) : undefined;
  }

  list(): MigrationJob[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(path.join(this.dir, f), 'utf8')) as MigrationJob)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}
