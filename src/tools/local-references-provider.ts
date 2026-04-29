import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import { StaticToolProvider } from './provider.js';
import type { ToolProvider } from './types.js';

export interface LocalReferenceRecord {
  path: string;
  symbolName: string;
  line: number;
  column: number;
  kind: 'definition' | 'reference' | 'implementation' | 'declaration';
  targetPath?: string;
  targetLine?: number;
  targetColumn?: number;
  source?: string;
}

export interface LocalReferencesArtifact {
  version: '1';
  references: LocalReferenceRecord[];
}

export function createLocalReferencesProvider(
  config: AppConfig,
  policy: PolicyEngine,
  providerId = 'local-references',
): ToolProvider {
  const artifactPath = path.join(config.workspaceRoot, '.marblecode', 'references.json');
  const provider = new StaticToolProvider(providerId, [{
    definition: {
      name: 'references_list',
      description: 'List readonly references from .marblecode/references.json.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          symbolName: { type: 'string' },
          kind: { type: 'string', enum: ['definition', 'reference', 'implementation', 'declaration'] },
        },
      },
    },
    async execute(input) {
      let artifact: LocalReferencesArtifact;
      try {
        policy.assertReadable(artifactPath);
        const raw = await readFile(artifactPath, 'utf8');
        artifact = JSON.parse(raw) as LocalReferencesArtifact;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          return { ok: true, data: [] };
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (artifact.version !== '1' || !Array.isArray(artifact.references)) {
        return {
          ok: false,
          error: 'Invalid local references artifact format',
        };
      }

      const requestedPath = typeof input.path === 'string' ? input.path : '';
      const requestedSymbolName = typeof input.symbolName === 'string' ? input.symbolName : '';
      const requestedKind = input.kind === 'definition'
        || input.kind === 'reference'
        || input.kind === 'implementation'
        || input.kind === 'declaration'
        ? input.kind
        : '';

      const normalized: LocalReferenceRecord[] = [];
      for (const reference of artifact.references) {
        const resolvedReferencePath = path.resolve(config.workspaceRoot, reference.path);
        const relativeReferencePath = path.relative(config.workspaceRoot, resolvedReferencePath).replace(/\\/g, '/');
        if (relativeReferencePath.startsWith('..') || path.isAbsolute(relativeReferencePath)) {
          return {
            ok: false,
            error: `Local references path escapes workspace: ${reference.path}`,
          };
        }
        try {
          policy.assertReadable(resolvedReferencePath);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        let normalizedTargetPath = '';
        if (reference.targetPath) {
          const resolvedTargetPath = path.resolve(config.workspaceRoot, reference.targetPath);
          normalizedTargetPath = path.relative(config.workspaceRoot, resolvedTargetPath).replace(/\\/g, '/');
          if (normalizedTargetPath.startsWith('..') || path.isAbsolute(normalizedTargetPath)) {
            return {
              ok: false,
              error: `Local references target path escapes workspace: ${reference.targetPath}`,
            };
          }
          try {
            policy.assertReadable(resolvedTargetPath);
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        normalized.push({
          path: relativeReferencePath,
          symbolName: reference.symbolName,
          line: reference.line,
          column: reference.column,
          kind: reference.kind,
          ...(normalizedTargetPath ? { targetPath: normalizedTargetPath } : {}),
          ...(typeof reference.targetLine === 'number' ? { targetLine: reference.targetLine } : {}),
          ...(typeof reference.targetColumn === 'number' ? { targetColumn: reference.targetColumn } : {}),
          ...(reference.source ? { source: reference.source } : {}),
        });
      }

      return {
        ok: true,
        data: normalized.filter((reference) => {
          if (requestedPath && reference.path !== requestedPath) {
            return false;
          }
          if (requestedSymbolName && reference.symbolName !== requestedSymbolName) {
            return false;
          }
          if (requestedKind && reference.kind !== requestedKind) {
            return false;
          }
          return true;
        }),
      };
    },
  }], {
    kind: 'external',
    access: 'read_only',
    description: 'Local readonly references source from .marblecode/references.json.',
    capabilities: ['references'],
  });

  provider.sanitizeLogRecord = (record: Record<string, unknown>) => ({
    ...record,
    referencesSource: typeof record.referencesSource === 'string' ? '[local-references]' : record.referencesSource,
  });

  return provider;
}
