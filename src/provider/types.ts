import type { UsageStats } from '../shared/types.js';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelReasoningConfig {
  effort?: 'low' | 'medium' | 'high';
  enabled?: boolean;
}

export interface ModelRequest {
  providerId: string;
  model: string;
  messages: ModelMessage[];
  systemPrompt?: string;
  stream?: boolean;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | string;
  reasoning?: ModelReasoningConfig;
  maxOutputTokens?: number;
  metadata?: Record<string, string>;
}

export interface ModelResponseChunk {
  type: 'text' | 'tool_call' | 'reasoning' | 'event';
  content: string;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelResponse {
  content: string;
  stopReason?: string;
  usage?: UsageStats;
  toolCalls?: ModelToolCall[];
  chunks?: ModelResponseChunk[];
  vendorMetadata?: Record<string, unknown>;
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  responseChunks: boolean;
  reasoningTokens: boolean;
  separateSystemPrompt: boolean;
}

export interface ModelProvider {
  id: string;
  capabilities: ProviderCapabilities;
  invoke(request: ModelRequest): Promise<ModelResponse>;
}
