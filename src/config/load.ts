import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import type {
  AppConfig,
  ContextConfig,
  ModelProfileConfig,
  ModelProfileConfigInput,
  PathPolicyConfig,
  PolicyConfig,
  ProjectConfigInput,
  ProviderConfig,
  ProviderConfigInput,
  RoutingConfig,
  SessionConfig,
  ShellPolicyConfig,
  VerifierConfigInput,
} from './schema.js';

const DEFAULT_CONFIG_FILE = 'agent.config.jsonc';
const DEFAULT_PROJECT_CONFIG_FILE = '.marblecode/config.jsonc';
const DEFAULT_VERIFIER_FILE = '.marblecode/verifier.md';

interface AppConfigInput {
  workspaceRoot?: string;
  providers?: Record<string, ProviderConfigInput>;
  models?: Record<string, ModelProfileConfigInput>;
  routing?: Partial<RoutingConfig>;
  context?: Partial<ContextConfig>;
  policy?: {
    path?: Partial<PathPolicyConfig>;
    shell?: Partial<ShellPolicyConfig>;
    network?: Partial<PolicyConfig['network']>;
  };
  verifier?: VerifierConfigInput;
  session?: Partial<SessionConfig>;
}

export async function loadConfig(configPath?: string, workspaceOverride?: string): Promise<AppConfig> {
  const resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(process.cwd(), DEFAULT_CONFIG_FILE);
  const parsed = await readJsoncFile<AppConfigInput>(resolvedPath);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid config file: ${resolvedPath}`);
  }

  const workspaceRoot = workspaceOverride
    ? path.resolve(workspaceOverride)
    : path.resolve(path.dirname(resolvedPath), parsed.workspaceRoot ?? '.');
  const projectDir = path.join(workspaceRoot, '.marblecode');
  const projectConfigPath = path.join(workspaceRoot, DEFAULT_PROJECT_CONFIG_FILE);
  const [projectConfigExists, projectParsed] = await Promise.all([
    fileExists(projectConfigPath),
    readOptionalJsoncFile<ProjectConfigInput>(projectConfigPath),
  ]);
  const projectConfig = projectParsed ?? {};
  const verifierPath = path.resolve(workspaceRoot, projectConfig.verifier?.path ?? parsed.verifier?.path ?? DEFAULT_VERIFIER_FILE);
  const verifierFileExists = await fileExists(verifierPath);
  const verifierCommands = projectConfig.verifier?.commands ?? parsed.verifier?.commands ?? [];
  const hasProjectVerifierSource = projectConfigExists || verifierFileExists;
  const explicitVerifierEnabled = projectConfig.verifier?.enabled ?? (hasProjectVerifierSource ? undefined : parsed.verifier?.enabled);
  const subtaskFallbackModel = projectConfig.routing?.subtaskFallbackModel ?? parsed.routing?.subtaskFallbackModel;
  const config: AppConfig = {
    workspaceRoot,
    providers: mergeProviderConfigs(parsed.providers ?? {}, projectConfig.providers ?? {}),
    models: mergeModelConfigs(parsed.models ?? {}, projectConfig.models ?? {}),
    routing: {
      defaultModel: projectConfig.routing?.defaultModel ?? parsed.routing?.defaultModel ?? 'cheap',
      codeModel: projectConfig.routing?.codeModel ?? parsed.routing?.codeModel ?? 'code',
      planningModel: projectConfig.routing?.planningModel ?? parsed.routing?.planningModel ?? 'strong',
      maxSteps: projectConfig.routing?.maxSteps ?? parsed.routing?.maxSteps ?? 8,
      maxAutoRepairAttempts: projectConfig.routing?.maxAutoRepairAttempts ?? parsed.routing?.maxAutoRepairAttempts ?? 2,
      maxConcurrentSubtasks: projectConfig.routing?.maxConcurrentSubtasks ?? parsed.routing?.maxConcurrentSubtasks ?? 1,
      subtaskMaxAttempts: projectConfig.routing?.subtaskMaxAttempts ?? parsed.routing?.subtaskMaxAttempts ?? 2,
      subtaskReplanOnFailure: projectConfig.routing?.subtaskReplanOnFailure ?? parsed.routing?.subtaskReplanOnFailure ?? true,
      subtaskConflictPolicy: projectConfig.routing?.subtaskConflictPolicy ?? parsed.routing?.subtaskConflictPolicy ?? 'serial',
      ...(typeof subtaskFallbackModel === 'string' && subtaskFallbackModel
        ? { subtaskFallbackModel }
        : {}),
    },
    context: {
      maxFiles: projectConfig.context?.maxFiles ?? parsed.context?.maxFiles ?? 8,
      maxChars: projectConfig.context?.maxChars ?? parsed.context?.maxChars ?? 24000,
      recentFileCount: projectConfig.context?.recentFileCount ?? parsed.context?.recentFileCount ?? 4,
      exclude: projectConfig.context?.exclude ?? parsed.context?.exclude ?? ['node_modules/**', '.git/**', '.agent/**'],
      sensitive: projectConfig.context?.sensitive ?? parsed.context?.sensitive ?? ['.env*', '**/*.pem', '**/*.key'],
      autoDeny: projectConfig.context?.autoDeny ?? parsed.context?.autoDeny ?? [],
    },
    policy: {
      path: {
        readWrite: projectConfig.policy?.path?.readWrite ?? parsed.policy?.path?.readWrite ?? ['.'],
        readOnly: projectConfig.policy?.path?.readOnly ?? parsed.policy?.path?.readOnly ?? [],
        deny: projectConfig.policy?.path?.deny ?? parsed.policy?.path?.deny ?? [],
      },
      shell: {
        enabled: projectConfig.policy?.shell?.enabled ?? parsed.policy?.shell?.enabled ?? true,
        workspaceOnly: projectConfig.policy?.shell?.workspaceOnly ?? parsed.policy?.shell?.workspaceOnly ?? true,
        inheritEnv: projectConfig.policy?.shell?.inheritEnv ?? parsed.policy?.shell?.inheritEnv ?? false,
        allowEnv: projectConfig.policy?.shell?.allowEnv ?? parsed.policy?.shell?.allowEnv ?? ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM'],
        denyCommands:
          projectConfig.policy?.shell?.denyCommands ?? parsed.policy?.shell?.denyCommands ?? ['sudo', 'curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'netcat', 'ping'],
        denyPatterns:
          projectConfig.policy?.shell?.denyPatterns ?? parsed.policy?.shell?.denyPatterns ?? ['rm -rf /', 'nohup', 'disown', '&', 'http://', 'https://', 'git clone', 'git fetch', 'git pull', 'git push'],
        timeoutMs: projectConfig.policy?.shell?.timeoutMs ?? parsed.policy?.shell?.timeoutMs ?? 120000,
        maxBufferBytes: projectConfig.policy?.shell?.maxBufferBytes ?? parsed.policy?.shell?.maxBufferBytes ?? 1024 * 1024,
      },
      network: {
        allowExternalToolNetwork:
          projectConfig.policy?.network?.allowExternalToolNetwork ?? parsed.policy?.network?.allowExternalToolNetwork ?? false,
        allowProviderHosts: projectConfig.policy?.network?.allowProviderHosts ?? parsed.policy?.network?.allowProviderHosts ?? [],
      },
    },
    verifier: {
      enabled: explicitVerifierEnabled ?? (verifierCommands.length > 0 || verifierFileExists),
      timeoutMs: projectConfig.verifier?.timeoutMs ?? parsed.verifier?.timeoutMs ?? 120000,
      commands: verifierCommands,
      path: verifierPath,
      autoAnalyzeFailures: projectConfig.verifier?.autoAnalyzeFailures ?? parsed.verifier?.autoAnalyzeFailures ?? true,
      allowDiscovery: explicitVerifierEnabled !== false,
    },
    session: {
      dir: projectConfig.session?.dir ?? parsed.session?.dir ?? '.agent/sessions',
      maxSessions: projectConfig.session?.maxSessions ?? parsed.session?.maxSessions ?? 100,
      maxAgeDays: projectConfig.session?.maxAgeDays ?? parsed.session?.maxAgeDays ?? 14,
      logPromptBodies: projectConfig.session?.logPromptBodies ?? parsed.session?.logPromptBodies ?? false,
      logToolBodies: projectConfig.session?.logToolBodies ?? parsed.session?.logToolBodies ?? false,
      redactSecrets: projectConfig.session?.redactSecrets ?? parsed.session?.redactSecrets ?? true,
      modelRetryAttempts: projectConfig.session?.modelRetryAttempts ?? parsed.session?.modelRetryAttempts ?? 3,
      modelRetryDelayMs: projectConfig.session?.modelRetryDelayMs ?? parsed.session?.modelRetryDelayMs ?? 3000,
    },
    project: {
      dir: projectDir,
      configPath: projectConfigExists ? projectConfigPath : null,
      env: sanitizeProjectEnv(projectConfig.env),
    },
  };

  validateConfig(config);
  return config;
}

async function readJsoncFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return parse(raw) as T;
}

async function readOptionalJsoncFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJsoncFile<T>(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function mergeProviderConfigs(
  base: Record<string, ProviderConfigInput>,
  overrides: Record<string, ProviderConfigInput>,
): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(overrides)])) {
    const value = {
      ...base[key],
      ...overrides[key],
    };
    merged[key] = {
      type: value.type ?? 'openai-compatible',
      baseUrl: value.baseUrl ?? '',
      apiKeyEnv: value.apiKeyEnv ?? '',
    };
  }
  return merged;
}

function mergeModelConfigs(
  base: Record<string, ModelProfileConfigInput>,
  overrides: Record<string, ModelProfileConfigInput>,
): Record<string, ModelProfileConfig> {
  const merged: Record<string, ModelProfileConfig> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(overrides)])) {
    const value = {
      ...base[key],
      ...overrides[key],
    };
    merged[key] = {
      provider: value.provider ?? '',
      model: value.model ?? '',
    };
  }
  return merged;
}

function sanitizeProjectEnv(input: Record<string, string> | undefined): Record<string, string> {
  if (!input) {
    return {};
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') {
      throw new Error(`Project env ${key} must be a string`);
    }
    env[key] = value;
  }

  return env;
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
