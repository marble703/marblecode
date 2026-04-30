import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { loadPlannerSessionSummary } from '../planner/read-api.js';
import { listRecentSessionEntries, type SessionEntry } from '../session/index.js';

export interface SessionListItem {
  id: string;
  dir: string;
  isPlanner: boolean;
  summary: string;
  schemaVersion?: string;
  outcome?: string;
  phase?: string;
  currentStepId?: string | null;
  degradedCompletion?: boolean;
  blockedStepIds?: string[];
  degradedStepIds?: string[];
}

export async function listRecentSessions(config: AppConfig, limit = 8): Promise<SessionListItem[]> {
  const entries = await listRecentSessionEntries(config, limit);
  return Promise.all(entries.map((entry) => buildSessionListItem(entry)));
}

async function buildSessionListItem(entry: SessionEntry): Promise<SessionListItem> {
  if (entry.isPlanner) {
    return loadPlannerSessionSummary(entry.id, entry.dir);
  }

  const request = await readJsonFile<{ prompt?: string }>(path.join(entry.dir, 'request.json'));
  return {
    id: entry.id,
    dir: entry.dir,
    isPlanner: false,
    summary: compactSummary(request?.prompt, '(session)'),
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function compactSummary(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (!value) {
      continue;
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      continue;
    }

    return normalized.length > 90 ? `${normalized.slice(0, 87)}...` : normalized;
  }

  return '(session)';
}
