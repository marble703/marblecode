import type { ProviderConfig } from '../config/schema.js';
import type { ModelProvider, ModelRequest, ModelResponse } from './types.js';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export class OpenAICompatibleProvider implements ModelProvider {
  public readonly capabilities = {
    streaming: true,
    toolCalling: true,
    responseChunks: true,
    reasoningTokens: true,
    separateSystemPrompt: true,
  } as const;

  public constructor(
    public readonly id: string,
    private readonly config: ProviderConfig,
  ) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = resolveApiKey(this.config.apiKeyEnv);
    if (!apiKey) {
      throw new Error('Missing provider credential from configured apiKeyEnv value');
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: toOpenAIMessages(request),
        stream: false,
        temperature: 0,
        tools: request.tools?.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: request.toolChoice,
        max_tokens: request.maxOutputTokens,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Provider request failed with status ${response.status}: ${errorText}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: {
          reasoning_tokens?: number;
        };
      };
    };

    const choice = payload.choices?.[0];
    const usage = {
      ...(payload.usage?.prompt_tokens !== undefined
        ? { inputTokens: payload.usage.prompt_tokens }
        : {}),
      ...(payload.usage?.completion_tokens !== undefined
        ? { outputTokens: payload.usage.completion_tokens }
        : {}),
      ...(payload.usage?.completion_tokens_details?.reasoning_tokens !== undefined
        ? { reasoningTokens: payload.usage.completion_tokens_details.reasoning_tokens }
        : {}),
    };

    return {
      content: choice?.message?.content ?? '',
      ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}),
      ...(choice?.message?.tool_calls
        ? {
            toolCalls: choice.message.tool_calls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            })),
          }
        : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      vendorMetadata: {
        provider: 'openai-compatible',
      },
    };
  }
}

function resolveApiKey(configuredValue: string): string | undefined {
  const fromEnv = process.env[configuredValue];
  if (fromEnv) {
    return fromEnv;
  }

  if (looksLikeInlineApiKey(configuredValue)) {
    return configuredValue;
  }

  return undefined;
}

function looksLikeInlineApiKey(value: string): boolean {
  if (value.length < 12) {
    return false;
  }

  return /[-_]/.test(value) || /\d/.test(value);
}

function toOpenAIMessages(request: ModelRequest): OpenAIMessage[] {
  const messages = [...request.messages];
  if (request.systemPrompt) {
    messages.unshift({
      role: 'system',
      content: request.systemPrompt,
    });
  }

  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}
