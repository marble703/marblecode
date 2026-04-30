import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { redactRecord } from '../shared/redact.js';

export interface SessionRecord {
  id: string;
  dir: string;
}

export interface SessionEntry {
  id: string;
  dir: string;
  isPlanner: boolean;
}

export async function createSession(config: AppConfig): Promise<SessionRecord> {
  const baseDir = path.resolve(config.workspaceRoot, config.session.dir);
  await mkdir(baseDir, { recursive: true });
  await cleanupSessions(baseDir, config.session.maxSessions, config.session.maxAgeDays);

  const baseId = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = attempt === 0 ? baseId : `${baseId}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(baseDir, id);
    try {
      await mkdir(dir);
      return { id, dir };
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
    }
  }

  throw new Error('Could not allocate a unique session directory');
}

export async function writeSessionArtifact(
  session: SessionRecord,
  fileName: string,
  content: string,
): Promise<void> {
  await writeFile(path.join(session.dir, fileName), content, 'utf8');
}

export async function appendSessionLog(
  session: SessionRecord,
  fileName: string,
  record: Record<string, unknown>,
  redactSecrets: boolean,
): Promise<void> {
  const payload = redactSecrets ? redactRecord(record) : record;
  await appendFile(path.join(session.dir, fileName), `${JSON.stringify(payload)}\n`, 'utf8');
}

export async function resolveSessionDir(
  config: AppConfig,
  sessionRef?: string,
  useLatest?: boolean,
): Promise<string> {
  const baseDir = path.resolve(config.workspaceRoot, config.session.dir);
  if (sessionRef) {
    if (path.isAbsolute(sessionRef)) {
      return sessionRef;
    }

    return path.join(baseDir, sessionRef);
  }

  if (!useLatest) {
    throw new Error('A session reference is required unless --last is used');
  }

  const entries = await readdir(baseDir, { withFileTypes: true });
  const latest = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .at(-1);

  if (!latest) {
    throw new Error('No session directories are available for rollback');
  }

  return path.join(baseDir, latest);
}

export async function resolvePlannerSessionDir(
  config: AppConfig,
  sessionRef?: string,
  useLatest?: boolean,
): Promise<string> {
  const baseDir = path.resolve(config.workspaceRoot, config.session.dir);
  if (sessionRef) {
    const sessionDir = path.isAbsolute(sessionRef) ? sessionRef : path.join(baseDir, sessionRef);
    await assertPlannerSessionDir(sessionDir);
    return sessionDir;
  }

  if (!useLatest) {
    throw new Error('A planner session reference is required unless --last is used');
  }

  const entries = await readdir(baseDir, { withFileTypes: true });
  const sorted = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const name of sorted) {
    const candidate = path.join(baseDir, name);
    if (await isPlannerSessionDir(candidate)) {
      return candidate;
    }
  }

  throw new Error('No planner session directories are available');
}

export async function listRecentSessionEntries(
  config: AppConfig,
  limit = 8,
): Promise<SessionEntry[]> {
  const baseDir = path.resolve(config.workspaceRoot, config.session.dir);
  const entries = await readdir(baseDir, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, limit * 2);

  const items: SessionEntry[] = [];
  for (const name of directories) {
    const dir = path.join(baseDir, name);
    items.push({
      id: name,
      dir,
      isPlanner: await isPlannerSessionDir(dir),
    });
    if (items.length >= limit) {
      break;
    }
  }

  return items;
}

async function cleanupSessions(baseDir: string, maxSessions: number, maxAgeDays: number): Promise<void> {
  const entries = await readdir(baseDir, { withFileTypes: true });
  const now = Date.now();
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      timestamp: Date.parse(entry.name),
    }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => right.timestamp - left.timestamp);

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  for (const entry of candidates) {
    if (now - entry.timestamp > maxAgeMs) {
      await rm(path.join(baseDir, entry.name), { recursive: true, force: true });
    }
  }

  const remaining = candidates.slice(0, maxSessions);
  const keep = new Set(remaining.map((entry) => entry.name));
  for (const entry of candidates) {
    if (!keep.has(entry.name)) {
      await rm(path.join(baseDir, entry.name), { recursive: true, force: true });
    }
  }
}

export async function isPlannerSessionDir(sessionDir: string): Promise<boolean> {
  try {
    await access(path.join(sessionDir, 'plan.json'));
    await access(path.join(sessionDir, 'plan.state.json'));
    await access(path.join(sessionDir, 'plan.events.jsonl'));
    return true;
  } catch {
    return false;
  }
}

async function assertPlannerSessionDir(sessionDir: string): Promise<void> {
  if (!(await isPlannerSessionDir(sessionDir))) {
    throw new Error(`Session is not a planner session: ${sessionDir}`);
  }
}
