export type ExecutionLockMode = 'write_locked' | 'guarded_read';

export interface ExecutionLockEntry {
  path: string;
  mode: ExecutionLockMode;
  ownerStepId: string;
  revision: number;
  transferredFrom?: string;
}

export interface ExecutionLockTable {
  version: '1';
  revision: number;
  entries: ExecutionLockEntry[];
}

export function createExecutionLockTable(revision: number): ExecutionLockTable {
  return {
    version: '1',
    revision,
    entries: [],
  };
}

export function acquireWriteLocks(table: ExecutionLockTable, stepId: string, fileScope: string[], revision: number): ExecutionLockTable {
  let next = table;
  for (const filePath of normalizePaths(fileScope)) {
    const existing = next.entries.find((entry) => entry.path === filePath);
    if (!existing) {
      next = {
        ...next,
        entries: [...next.entries, { path: filePath, mode: 'write_locked', ownerStepId: stepId, revision }],
      };
      continue;
    }
    if (existing.ownerStepId === stepId) {
      next = replaceEntry(next, { ...existing, mode: 'write_locked', revision });
      continue;
    }
    throw new Error(`Write lock conflict for ${filePath}: owned by ${existing.ownerStepId}`);
  }
  return next;
}

export function downgradeToGuardedRead(table: ExecutionLockTable, stepId: string, fileScope: string[], revision: number): ExecutionLockTable {
  let next = table;
  for (const filePath of normalizePaths(fileScope)) {
    const existing = next.entries.find((entry) => entry.path === filePath && entry.ownerStepId === stepId);
    if (!existing) {
      continue;
    }
    next = replaceEntry(next, { ...existing, mode: 'guarded_read', revision });
  }
  return next;
}

export function transferWriteOwnership(
  table: ExecutionLockTable,
  fromStepId: string,
  toStepId: string,
  fileScope: string[],
  revision: number,
): ExecutionLockTable {
  let next = table;
  for (const filePath of normalizePaths(fileScope)) {
    const existing = next.entries.find((entry) => entry.path === filePath && entry.ownerStepId === fromStepId);
    if (!existing) {
      continue;
    }
    next = replaceEntry(next, {
      path: filePath,
      mode: 'write_locked',
      ownerStepId: toStepId,
      revision,
      transferredFrom: fromStepId,
    });
  }
  return next;
}

export function assertStepCanWrite(table: ExecutionLockTable, stepId: string, targetPath: string): void {
  const normalized = normalizePaths([targetPath])[0];
  if (!normalized) {
    throw new Error(`Write lock missing for ${targetPath}`);
  }
  const entry = table.entries.find((candidate) => candidate.path === normalized);
  if (!entry) {
    throw new Error(`Write lock missing for ${normalized}`);
  }
  if (entry.ownerStepId !== stepId || entry.mode !== 'write_locked') {
    throw new Error(`Write lock denied for ${normalized}; current owner is ${entry.ownerStepId}`);
  }
}

function replaceEntry(table: ExecutionLockTable, entry: ExecutionLockEntry): ExecutionLockTable {
  return {
    ...table,
    entries: table.entries.map((candidate) => (candidate.path === entry.path ? entry : candidate)),
  };
}

function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths.map((filePath) => filePath.replace(/\\/g, '/').replace(/^\.\//, '')))].filter(Boolean);
}
