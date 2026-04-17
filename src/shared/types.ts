export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Result<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}
