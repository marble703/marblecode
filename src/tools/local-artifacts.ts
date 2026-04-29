import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';

export type LocalArtifactReadResult<T> =
  | { status: 'ok'; artifact: T }
  | { status: 'missing' }
  | { status: 'error'; error: string };

export function createLocalArtifactPath(config: AppConfig, artifactFileName: string): string {
  return path.join(config.workspaceRoot, '.marblecode', artifactFileName);
}

export async function readLocalArtifact<T>(
  config: AppConfig,
  policy: PolicyEngine,
  artifactFileName: string,
): Promise<LocalArtifactReadResult<T>> {
  const artifactPath = createLocalArtifactPath(config, artifactFileName);
  try {
    policy.assertReadable(artifactPath);
    const raw = await readFile(artifactPath, 'utf8');
    return {
      status: 'ok',
      artifact: JSON.parse(raw) as T,
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type NormalizeWorkspacePathResult =
  | { status: 'ok'; path: string }
  | { status: 'error'; error: string };

export function normalizeWorkspacePath(
  config: AppConfig,
  policy: PolicyEngine,
  rawPath: string,
  errorPrefix: string,
): NormalizeWorkspacePathResult {
  const resolvedPath = path.resolve(config.workspaceRoot, rawPath);
  const relativePath = path.relative(config.workspaceRoot, resolvedPath).replace(/\\/g, '/');
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return {
      status: 'error',
      error: `${errorPrefix}: ${rawPath}`,
    };
  }
  try {
    policy.assertReadable(resolvedPath);
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: 'ok',
    path: relativePath,
  };
}
