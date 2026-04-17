export interface ProviderConfig {
  type: 'openai-compatible';
  baseUrl: string;
  apiKeyEnv: string;
}

export interface ModelProfileConfig {
  provider: string;
  model: string;
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
}

export interface SessionConfig {
  dir: string;
  maxSessions: number;
  maxAgeDays: number;
  logPromptBodies: boolean;
  logToolBodies: boolean;
  redactSecrets: boolean;
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
}
