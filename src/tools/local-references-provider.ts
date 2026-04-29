import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import { normalizeWorkspacePath, readLocalArtifact } from './local-artifacts.js';
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
      const artifactResult = await readLocalArtifact<LocalReferencesArtifact>(config, policy, 'references.json');
      if (artifactResult.status === 'missing') {
        return { ok: true, data: [] };
      }
      if (artifactResult.status === 'error') {
        return {
          ok: false,
          error: artifactResult.error,
        };
      }
      const artifact = artifactResult.artifact;

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
        const normalizedPath = normalizeWorkspacePath(config, policy, reference.path, 'Local references path escapes workspace');
        if (normalizedPath.status === 'error') {
          return {
            ok: false,
            error: normalizedPath.error,
          };
        }

        let normalizedTargetPath = '';
        if (reference.targetPath) {
          const normalizedTarget = normalizeWorkspacePath(config, policy, reference.targetPath, 'Local references target path escapes workspace');
          if (normalizedTarget.status === 'error') {
            return {
              ok: false,
              error: normalizedTarget.error,
            };
          }
          normalizedTargetPath = normalizedTarget.path;
        }

        normalized.push({
          path: normalizedPath.path,
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
