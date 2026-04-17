import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
