import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
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
  const artifactPath = path.join(config.workspaceRoot, '.marblecode', 'diagnostics.json');
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
      let artifact: LocalDiagnosticsArtifact;
      try {
        policy.assertReadable(artifactPath);
        const raw = await readFile(artifactPath, 'utf8');
        artifact = JSON.parse(raw) as LocalDiagnosticsArtifact;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          return { ok: true, data: [] };
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

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
        const resolvedDiagnosticPath = path.resolve(config.workspaceRoot, diagnostic.path);
        const relativeDiagnosticPath = path.relative(config.workspaceRoot, resolvedDiagnosticPath).replace(/\\/g, '/');
        if (relativeDiagnosticPath.startsWith('..') || path.isAbsolute(relativeDiagnosticPath)) {
          return {
            ok: false,
            error: `Local diagnostics path escapes workspace: ${diagnostic.path}`,
          };
        }
        try {
          policy.assertReadable(resolvedDiagnosticPath);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        normalized.push({
          path: relativeDiagnosticPath,
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
