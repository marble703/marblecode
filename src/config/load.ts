import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import type { AppConfig } from './schema.js';

const DEFAULT_CONFIG_FILE = 'agent.config.jsonc';

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(process.cwd(), DEFAULT_CONFIG_FILE);
  const raw = await readFile(resolvedPath, 'utf8');
  const parsed = parse(raw) as Partial<AppConfig>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid config file: ${resolvedPath}`);
  }

  const workspaceRoot = path.resolve(path.dirname(resolvedPath), parsed.workspaceRoot ?? '.');
  const config: AppConfig = {
    workspaceRoot,
    providers: parsed.providers ?? {},
    models: parsed.models ?? {},
    routing: {
      defaultModel: parsed.routing?.defaultModel ?? 'cheap',
      codeModel: parsed.routing?.codeModel ?? 'code',
      planningModel: parsed.routing?.planningModel ?? 'strong',
      maxSteps: parsed.routing?.maxSteps ?? 8,
      maxAutoRepairAttempts: parsed.routing?.maxAutoRepairAttempts ?? 2,
    },
    context: {
      maxFiles: parsed.context?.maxFiles ?? 8,
      maxChars: parsed.context?.maxChars ?? 24000,
      recentFileCount: parsed.context?.recentFileCount ?? 4,
      exclude: parsed.context?.exclude ?? ['node_modules/**', '.git/**', '.agent/**'],
      sensitive: parsed.context?.sensitive ?? ['.env*', '**/*.pem', '**/*.key'],
    },
    policy: {
      path: {
        readWrite: parsed.policy?.path?.readWrite ?? ['.'],
        readOnly: parsed.policy?.path?.readOnly ?? [],
        deny: parsed.policy?.path?.deny ?? [],
      },
      shell: {
        enabled: parsed.policy?.shell?.enabled ?? true,
        workspaceOnly: parsed.policy?.shell?.workspaceOnly ?? true,
        inheritEnv: parsed.policy?.shell?.inheritEnv ?? false,
        allowEnv: parsed.policy?.shell?.allowEnv ?? ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM'],
        denyCommands:
          parsed.policy?.shell?.denyCommands ?? ['sudo', 'curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'netcat', 'ping'],
        denyPatterns:
          parsed.policy?.shell?.denyPatterns ?? ['rm -rf /', 'nohup', 'disown', '&', 'http://', 'https://', 'git clone', 'git fetch', 'git pull', 'git push'],
        timeoutMs: parsed.policy?.shell?.timeoutMs ?? 120000,
        maxBufferBytes: parsed.policy?.shell?.maxBufferBytes ?? 1024 * 1024,
      },
      network: {
        allowExternalToolNetwork: parsed.policy?.network?.allowExternalToolNetwork ?? false,
        allowProviderHosts: parsed.policy?.network?.allowProviderHosts ?? [],
      },
    },
    verifier: {
      enabled: parsed.verifier?.enabled ?? false,
      timeoutMs: parsed.verifier?.timeoutMs ?? 120000,
      commands: parsed.verifier?.commands ?? [],
    },
    session: {
      dir: parsed.session?.dir ?? '.agent/sessions',
      maxSessions: parsed.session?.maxSessions ?? 100,
      maxAgeDays: parsed.session?.maxAgeDays ?? 14,
      logPromptBodies: parsed.session?.logPromptBodies ?? false,
      logToolBodies: parsed.session?.logToolBodies ?? false,
      redactSecrets: parsed.session?.redactSecrets ?? true,
    },
  };

  validateConfig(config);
  return config;
}

function validateConfig(config: AppConfig): void {
  if (Object.keys(config.providers).length === 0) {
    throw new Error('At least one provider must be configured');
  }

  for (const [providerId, provider] of Object.entries(config.providers)) {
    const url = new URL(provider.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Provider ${providerId} must use http or https`);
    }

    if (config.policy.network.allowProviderHosts.length > 0 && !config.policy.network.allowProviderHosts.includes(url.host)) {
      throw new Error(`Provider host ${url.host} is not allowed by policy`);
    }
  }

  for (const [modelAlias, model] of Object.entries(config.models)) {
    if (!config.providers[model.provider]) {
      throw new Error(`Model ${modelAlias} references unknown provider ${model.provider}`);
    }
  }
}
