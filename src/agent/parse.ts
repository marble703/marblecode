import { parsePatchDocument } from '../patch/codec.js';
import type { PatchDocument } from '../patch/types.js';
import { extractJsonObject } from '../shared/json-response.js';

export type AgentStep =
  | {
      type: 'tool_call';
      thought?: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'patch';
      thought?: string;
      patch: PatchDocument;
    }
  | {
      type: 'final';
      thought?: string;
      message: string;
    };

export function parseAgentStep(content: string): AgentStep {
  const parsed = JSON.parse(extractJsonObject(content)) as Record<string, unknown>;
  const type = parsed.type;
  if (type === 'tool_call') {
    return withOptionalThought(
      {
        type: 'tool_call',
        tool: String(parsed.tool),
        input: (parsed.input as Record<string, unknown>) ?? {},
      },
      parsed.thought,
    );
  }

  if (type === 'patch') {
    return withOptionalThought(
      {
        type: 'patch',
        patch: parsePatchDocument(JSON.stringify(parsed.patch)),
      },
      parsed.thought,
    );
  }

  if (type === 'final') {
    return withOptionalThought(
      {
        type: 'final',
        message: String(parsed.message ?? ''),
      },
      parsed.thought,
    );
  }

  throw new Error('Model response did not contain a valid agent step');
}

function withOptionalThought<T extends AgentStep>(step: T, thought: unknown): T {
  if (typeof thought === 'string') {
    return {
      ...step,
      thought,
    };
  }

  return step;
}
