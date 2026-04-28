import { buildContext } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import type { ModelRequest } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';

export function buildModelRequest(
  config: AppConfig,
  model: string,
  providerId: string,
  prompt: string,
  context: Awaited<ReturnType<typeof buildContext>>,
  transcript: string[],
  tools: ReturnType<ToolRegistry['listDefinitions']>,
): ModelRequest {
  const contextText = context.items
    .map((item) => {
      const warning = item.warning ? `Warning: ${item.warning}\n` : '';
      return `File: ${item.path}\nSource: ${item.source}\nReason: ${item.reason}\n${warning}${item.excerpt}`;
    })
    .join('\n\n---\n\n');
  const toolText = tools
    .map((tool) => `- ${tool.name}: ${tool.description} input=${JSON.stringify(tool.inputSchema)}`)
    .join('\n');

  return {
    providerId,
    model,
    systemPrompt: buildSystemPrompt(config.routing.maxSteps),
    messages: [
      {
        role: 'user',
        content: [
          `User request:\n${prompt}`,
          `Available tools:\n${toolText || '(none)'}`,
          context.selectionSummary,
          `Context:\n${contextText || '(no context selected)'}`,
          transcript.length > 0 ? `Transcript:\n${transcript.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    stream: false,
    maxOutputTokens: 4000,
    metadata: {
      mode: 'mvp-json-loop',
    },
  };
}

export function buildSystemPrompt(maxSteps: number): string {
  return [
    'You are a coding agent operating inside a secure local host.',
    `You may take at most ${maxSteps} steps before the host will stop you.`,
    'Valid response types are JSON objects with type = tool_call, patch, or final.',
    'Do not output prose outside JSON.',
    'Never request write_file. The host applies structured patches on your behalf.',
    'If the user did not provide target files or the selected context is incomplete, search before editing with search_text, list_files, and read_file.',
    'Treat pasted snippets such as [Pasted ~12 lines #1] as first-class search clues for identifiers, errors, and nearby code.',
    'When using replace_file, newText must contain the full final file content, not a partial diff.',
    'Patch documents may contain multiple operations when one fix spans multiple files such as implementation, tests, config, or verifier docs.',
    'Prefer read_file before editing unless the file content is already fully present in context.',
    'Sensitive files such as .env are unavailable unless they were explicitly supplied.',
    'Project-scoped verification plans may live in .marblecode/verifier.md. If verifier analysis says the verification plan is stale, you may update that file.',
    'Patch responses must follow this schema:',
    '{"type":"patch","thought":"...","patch":{"version":"1","summary":"...","operations":[{"type":"replace_file","path":"src/file.ts","diff":"brief summary","newText":"full file contents"},{"type":"replace_file","path":"tests/file.test.ts","diff":"brief summary","newText":"full file contents"}]}}',
  ].join(' ');
}

export function countSnippetLines(snippet: string): number {
  return snippet.split(/\r?\n/).filter((line) => line.length > 0).length || 1;
}
