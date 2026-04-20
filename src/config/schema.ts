export interface ProviderConfig {
  type: 'openai-compatible';
  baseUrl: string;
  apiKeyEnv: string;
}

export interface ProviderConfigInput {
  type?: 'openai-compatible';
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface ModelProfileConfig {
  provider: string;
  model: string;
}

export interface ModelProfileConfigInput {
  provider?: string;
  model?: string;
}

export interface RoutingConfig {
  defaultModel: string;
  codeModel: string;
  planningModel: string;
  maxSteps: number;
  maxAutoRepairAttempts: number;
}

export interface ContextConfig {
  maxFiles: number;
  maxChars: number;
  recentFileCount: number;
  exclude: string[];
  sensitive: string[];
}

export interface PathPolicyConfig {
  readWrite: string[];
  readOnly: string[];
  deny: string[];
}

export interface ShellPolicyConfig {
  enabled: boolean;
  workspaceOnly: boolean;
  inheritEnv: boolean;
  allowEnv: string[];
  denyCommands: string[];
  denyPatterns: string[];
  timeoutMs: number;
  maxBufferBytes: number;
}

export interface NetworkPolicyConfig {
  allowExternalToolNetwork: boolean;
  allowProviderHosts: string[];
}

export interface PolicyConfig {
  path: PathPolicyConfig;
  shell: ShellPolicyConfig;
  network: NetworkPolicyConfig;
}

export interface VerifierConfig {
  enabled: boolean;
  timeoutMs: number;
  commands: string[];
  path: string;
  autoAnalyzeFailures: boolean;
  allowDiscovery: boolean;
}

export interface VerifierConfigInput {
  enabled?: boolean;
  timeoutMs?: number;
  commands?: string[];
  path?: string;
  autoAnalyzeFailures?: boolean;
}

export interface SessionConfig {
  dir: string;
  maxSessions: number;
  maxAgeDays: number;
  logPromptBodies: boolean;
  logToolBodies: boolean;
  redactSecrets: boolean;
  modelRetryAttempts: number;
  modelRetryDelayMs: number;
}

export interface ProjectConfigInput {
  providers?: Record<string, ProviderConfigInput>;
  models?: Record<string, ModelProfileConfigInput>;
  routing?: Partial<RoutingConfig>;
  context?: Partial<ContextConfig>;
  policy?: {
    path?: Partial<PathPolicyConfig>;
    shell?: Partial<ShellPolicyConfig>;
    network?: Partial<NetworkPolicyConfig>;
  };
  verifier?: VerifierConfigInput;
  session?: Partial<SessionConfig>;
  env?: Record<string, string>;
}

export interface ProjectConfig {
  dir: string;
  configPath: string | null;
  env: Record<string, string>;
}

export interface AppConfig {
  workspaceRoot: string;
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelProfileConfig>;
  routing: RoutingConfig;
  context: ContextConfig;
  policy: PolicyConfig;
  verifier: VerifierConfig;
  session: SessionConfig;
  project: ProjectConfig;
}
