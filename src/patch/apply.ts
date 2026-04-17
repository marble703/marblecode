import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPatch } from 'diff';
import { PolicyEngine } from '../policy/index.js';
import type { PatchApplyResult, PatchDocument, RollbackOperation } from './types.js';

export interface PatchPreviewItem {
  path: string;
  type: string;
  summary: string;
  preview: string;
}

export async function previewPatch(
  workspaceRoot: string,
  patch: PatchDocument,
): Promise<PatchPreviewItem[]> {
  const previews: PatchPreviewItem[] = [];

  for (const operation of patch.operations) {
    const absolutePath = path.resolve(workspaceRoot, operation.path);
    let previous = '';
    try {
      previous = await readFile(absolutePath, 'utf8');
    } catch {
      previous = '';
    }

    const next =
      operation.type === 'delete_file'
        ? ''
        : operation.type === 'create_file'
          ? operation.content
          : operation.newText;

    previews.push({
      path: operation.path,
      type: operation.type,
      summary: operation.diff,
      preview: createPatch(operation.path, previous, next),
    });
  }

  return previews;
}

export async function applyPatch(
  workspaceRoot: string,
  patch: PatchDocument,
  policy: PolicyEngine,
): Promise<PatchApplyResult> {
  const rollback: RollbackOperation[] = [];
  const changedFiles: string[] = [];

  for (const operation of patch.operations) {
    const absolutePath = path.resolve(workspaceRoot, operation.path);
    if (operation.type === 'create_file') {
      policy.assertWritable(absolutePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      rollback.unshift({
        type: 'remove_file',
        path: operation.path,
      });
      await writeFile(absolutePath, operation.content, 'utf8');
      changedFiles.push(operation.path);
      continue;
    }

    if (operation.type === 'replace_file') {
      policy.assertWritable(absolutePath);
      const previous = await readFile(absolutePath, 'utf8');
      if (operation.oldText !== undefined && previous !== operation.oldText) {
        throw new Error(`Patch precondition failed for ${operation.path}`);
      }

      rollback.unshift({
        type: 'restore_file',
        path: operation.path,
        content: previous,
      });
      await writeFile(absolutePath, operation.newText, 'utf8');
      changedFiles.push(operation.path);
      continue;
    }

    if (operation.type === 'delete_file') {
      policy.assertWritable(absolutePath);
      const previous = await readFile(absolutePath, 'utf8');
      if (operation.expectedText !== undefined && previous !== operation.expectedText) {
        throw new Error(`Patch precondition failed for ${operation.path}`);
      }

      rollback.unshift({
        type: 'restore_file',
        path: operation.path,
        content: previous,
      });
      await rm(absolutePath);
      changedFiles.push(operation.path);
    }
  }

  return {
    changedFiles,
    rollback,
  };
}

export async function rollbackPatch(
  workspaceRoot: string,
  rollback: RollbackOperation[],
  policy: PolicyEngine,
): Promise<void> {
  for (const operation of rollback) {
    const absolutePath = path.resolve(workspaceRoot, operation.path);
    policy.assertWritable(absolutePath);
    if (operation.type === 'restore_file') {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, operation.content, 'utf8');
      continue;
    }

    await rm(absolutePath, { force: true });
  }
}
