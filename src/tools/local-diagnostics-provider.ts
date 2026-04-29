import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import { normalizeWorkspacePath, readLocalArtifact } from './local-artifacts.js';
import { StaticToolProvider } from './provider.js';
import type { ToolProvider } from './types.js';

export interface LocalDiagnosticsRecord {
  path: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  line: number;
  column: number;
  source?: string;
}

export interface LocalDiagnosticsArtifact {
  version: '1';
  diagnostics: LocalDiagnosticsRecord[];
}

export function createLocalDiagnosticsProvider(
  config: AppConfig,
  policy: PolicyEngine,
  providerId = 'local-diagnostics',
): ToolProvider {
  const provider = new StaticToolProvider(providerId, [{
    definition: {
      name: 'diagnostics_list',
      description: 'List readonly diagnostics from .marblecode/diagnostics.json.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
        },
      },
    },
    async execute(input) {
      const artifactResult = await readLocalArtifact<LocalDiagnosticsArtifact>(config, policy, 'diagnostics.json');
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

      if (artifact.version !== '1' || !Array.isArray(artifact.diagnostics)) {
        return {
          ok: false,
          error: 'Invalid local diagnostics artifact format',
        };
      }

      const requestedPath = typeof input.path === 'string' ? input.path : '';
      const requestedSeverity = input.severity === 'info' || input.severity === 'warning' || input.severity === 'error'
        ? input.severity
        : '';

      const normalized: LocalDiagnosticsRecord[] = [];
      for (const diagnostic of artifact.diagnostics) {
        const normalizedPath = normalizeWorkspacePath(config, policy, diagnostic.path, 'Local diagnostics path escapes workspace');
        if (normalizedPath.status === 'error') {
          return {
            ok: false,
            error: normalizedPath.error,
          };
        }
        normalized.push({
          path: normalizedPath.path,
          severity: diagnostic.severity,
          message: diagnostic.message,
          line: diagnostic.line,
          column: diagnostic.column,
          ...(diagnostic.source ? { source: diagnostic.source } : {}),
        });
      }

      return {
        ok: true,
        data: normalized.filter((diagnostic) => {
          if (requestedPath && diagnostic.path !== requestedPath) {
            return false;
          }
          if (requestedSeverity && diagnostic.severity !== requestedSeverity) {
            return false;
          }
          return true;
        }),
      };
    },
  }], {
    kind: 'external',
    access: 'read_only',
    description: 'Local readonly diagnostics source from .marblecode/diagnostics.json.',
    capabilities: ['diagnostics'],
  });

  provider.sanitizeLogRecord = (record: Record<string, unknown>) => ({
    ...record,
    diagnosticsSource: typeof record.diagnosticsSource === 'string' ? '[local-diagnostics]' : record.diagnosticsSource,
  });

  return provider;
}
