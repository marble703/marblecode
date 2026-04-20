import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { redactRecord } from '../shared/redact.js';

export interface SessionRecord {
  id: string;
  dir: string;
}

export async function createSession(config: AppConfig): Promise<SessionRecord> {
  const baseDir = path.resolve(config.workspaceRoot, config.session.dir);
  await mkdir(baseDir, { recursive: true });
  await cleanupSessions(baseDir, config.session.maxSessions, config.session.maxAgeDays);

  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(baseDir, id);
  await mkdir(dir, { recursive: true });
  return { id, dir };
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
  const filePath = path.join(session.dir, fileName);
  let current = '';
  try {
    current = await readFile(filePath, 'utf8');
  } catch {
    current = '';
  }

  const payload = redactSecrets ? redactRecord(record) : record;
  const next = `${current}${JSON.stringify(payload)}\n`;
  await writeFile(filePath, next, 'utf8');
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

async function isPlannerSessionDir(sessionDir: string): Promise<boolean> {
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
