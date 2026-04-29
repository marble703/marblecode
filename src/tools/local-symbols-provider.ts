import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import { normalizeWorkspacePath, readLocalArtifact } from './local-artifacts.js';
import { StaticToolProvider } from './provider.js';
import type { ToolProvider } from './types.js';

export interface LocalSymbolRecord {
  path: string;
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable' | 'constant' | 'type';
  line: number;
  column: number;
  containerName?: string;
  source?: string;
}

export interface LocalSymbolsArtifact {
  version: '1';
  symbols: LocalSymbolRecord[];
}

export function createLocalSymbolsProvider(
  config: AppConfig,
  policy: PolicyEngine,
  providerId = 'local-symbols',
): ToolProvider {
  const provider = new StaticToolProvider(providerId, [{
    definition: {
      name: 'symbols_list',
      description: 'List readonly symbols from .marblecode/symbols.json.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['function', 'class', 'method', 'variable', 'constant', 'type'] },
        },
      },
    },
    async execute(input) {
      const artifactResult = await readLocalArtifact<LocalSymbolsArtifact>(config, policy, 'symbols.json');
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

      if (artifact.version !== '1' || !Array.isArray(artifact.symbols)) {
        return {
          ok: false,
          error: 'Invalid local symbols artifact format',
        };
      }

      const requestedPath = typeof input.path === 'string' ? input.path : '';
      const requestedName = typeof input.name === 'string' ? input.name : '';
      const requestedKind = input.kind === 'function'
        || input.kind === 'class'
        || input.kind === 'method'
        || input.kind === 'variable'
        || input.kind === 'constant'
        || input.kind === 'type'
        ? input.kind
        : '';

      const normalized: LocalSymbolRecord[] = [];
      for (const symbol of artifact.symbols) {
        const normalizedPath = normalizeWorkspacePath(config, policy, symbol.path, 'Local symbols path escapes workspace');
        if (normalizedPath.status === 'error') {
          return {
            ok: false,
            error: normalizedPath.error,
          };
        }
        normalized.push({
          path: normalizedPath.path,
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          column: symbol.column,
          ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
          ...(symbol.source ? { source: symbol.source } : {}),
        });
      }

      return {
        ok: true,
        data: normalized.filter((symbol) => {
          if (requestedPath && symbol.path !== requestedPath) {
            return false;
          }
          if (requestedName && symbol.name !== requestedName) {
            return false;
          }
          if (requestedKind && symbol.kind !== requestedKind) {
            return false;
          }
          return true;
        }),
      };
    },
  }], {
    kind: 'external',
    access: 'read_only',
    description: 'Local readonly symbols source from .marblecode/symbols.json.',
    capabilities: ['symbols'],
  });

  provider.sanitizeLogRecord = (record: Record<string, unknown>) => ({
    ...record,
    symbolsSource: typeof record.symbolsSource === 'string' ? '[local-symbols]' : record.symbolsSource,
  });

  return provider;
}
