import { StaticToolProvider } from './provider.js';
import type { ToolProvider } from './types.js';

export interface ToolDiagnosticRecord {
  path: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  line: number;
  column: number;
}

export function createDiagnosticsFixtureProvider(
  diagnostics: ToolDiagnosticRecord[],
  providerId = 'diagnostics-fixture',
): ToolProvider {
  return new StaticToolProvider(providerId, [{
    definition: {
      name: 'diagnostics_list',
      description: 'List deterministic readonly diagnostics for a workspace path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
      },
    },
    async execute(input) {
      const requestedPath = typeof input.path === 'string' ? input.path : '';
      const filtered = requestedPath
        ? diagnostics.filter((diagnostic) => diagnostic.path === requestedPath)
        : diagnostics;
      return {
        ok: true,
        data: filtered,
      };
    },
  }], {
    kind: 'fixture',
    access: 'read_only',
    description: 'Deterministic readonly diagnostics fixture provider.',
    capabilities: ['diagnostics'],
  });
}
