import { exec as execCallback, execFile as execFileCallback } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { Tool } from './types.js';

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);

export function createBuiltinTools(config: AppConfig, policy: PolicyEngine): Tool[] {
  return [
    createReadFileTool(config, policy),
    createListFilesTool(config, policy),
    createSearchTextTool(config, policy),
    createRunShellTool(config, policy),
    createGitStatusTool(config),
    createGitLogTool(config),
    createGitShowTool(config),
    createGitDiffTool(config),
    createGitDiffBaseTool(config),
  ];
}

export function createPlannerTools(config: AppConfig, policy: PolicyEngine): Tool[] {
  const allowed = new Set(['read_file', 'list_files', 'search_text', 'git_status', 'git_log', 'git_show', 'git_diff', 'git_diff_base']);
  return createBuiltinTools(config, policy).filter((tool) => allowed.has(tool.definition.name));
}

function createReadFileTool(config: AppConfig, policy: PolicyEngine): Tool {
  return {
    definition: {
      name: 'read_file',
      description: 'Read a UTF-8 text file in the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
    async execute(input) {
      const targetPath = path.resolve(config.workspaceRoot, String(input.path));
      try {
        policy.assertReadable(targetPath);
        if (policy.isSensitive(targetPath)) {
          throw new Error('Sensitive files are excluded from tool-based context access');
        }

        const content = await readFile(targetPath, 'utf8');
        return {
          ok: true,
          data: {
            path: path.relative(config.workspaceRoot, targetPath),
            content,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function createListFilesTool(config: AppConfig, policy: PolicyEngine): Tool {
  return {
    definition: {
      name: 'list_files',
      description: 'List files under a workspace directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          pattern: { type: 'string' },
        },
      },
    },
    async execute(input) {
      try {
        const targetDir = path.resolve(config.workspaceRoot, String(input.path ?? '.'));
        policy.assertReadable(targetDir);
        const files = await walkFiles(config.workspaceRoot, targetDir, [...config.context.exclude, ...config.context.autoDeny]);
        const pattern = typeof input.pattern === 'string' ? input.pattern : '**/*';
        return {
          ok: true,
          data: files.filter((file) => minimatch(file, pattern, { dot: true })),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function createSearchTextTool(config: AppConfig, policy: PolicyEngine): Tool {
  return {
    definition: {
      name: 'search_text',
      description: 'Search workspace text files with a regular expression.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          flags: { type: 'string' },
          pathPattern: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
    async execute(input) {
      try {
        const flags = normalizeRegexFlags(input.flags);
        const regex = new RegExp(String(input.pattern), flags);
        const files = await walkFiles(config.workspaceRoot, config.workspaceRoot, [...config.context.exclude, ...config.context.autoDeny]);
        const pathPattern = typeof input.pathPattern === 'string' ? input.pathPattern : '**/*';
        const matches: Array<{
          path: string;
          count: number;
          matches: Array<{ line: number; column: number; match: string; context: string }>;
        }> = [];
        for (const file of files) {
          if (!minimatch(file, pathPattern, { dot: true })) {
            continue;
          }

          const targetPath = path.resolve(config.workspaceRoot, file);
          policy.assertReadable(targetPath);
          if (policy.isSensitive(targetPath)) {
            continue;
          }

          const content = await readFile(targetPath, 'utf8');
          const fileMatches = [...content.matchAll(regex)].map((match) => {
            const startIndex = match.index ?? 0;
            const position = getLineAndColumn(content, startIndex);
            return {
              line: position.line,
              column: position.column,
              match: match[0] ?? '',
              context: getLineText(content, startIndex),
            };
          });
          if (fileMatches.length > 0) {
            matches.push({ path: file, count: fileMatches.length, matches: fileMatches });
          }
        }

        return {
          ok: true,
          data: matches,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function normalizeRegexFlags(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    return 'g';
  }

  return input.includes('g') ? input : `${input}g`;
}

function getLineAndColumn(content: string, index: number): { line: number; column: number } {
  const prefix = content.slice(0, index);
  const lines = prefix.split('\n');
  const line = lines.length;
  const column = (lines.at(-1)?.length ?? 0) + 1;
  return { line, column };
}

function getLineText(content: string, index: number): string {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  const nextBreak = content.indexOf('\n', index);
  const lineEnd = nextBreak === -1 ? content.length : nextBreak;
  return content.slice(lineStart, lineEnd);
}

function createRunShellTool(config: AppConfig, policy: PolicyEngine): Tool {
  return {
    definition: {
      name: 'run_shell',
      description: 'Run a workspace-scoped shell command with policy checks.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
    async execute(input) {
      try {
        const command = String(input.command);
        policy.assertShellCommand(command);
        const { stdout, stderr } = await exec(command, {
          cwd: config.workspaceRoot,
          env: policy.filterShellEnv(),
          timeout: config.policy.shell.timeoutMs,
          maxBuffer: config.policy.shell.maxBufferBytes,
        });
        return {
          ok: true,
          stdout,
          stderr,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function createGitDiffTool(config: AppConfig): Tool {
  return {
    definition: {
      name: 'git_diff',
      description: 'Read git diff output for the current repository.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async execute() {
      try {
        const { stdout, stderr } = await exec('git diff --no-ext-diff --minimal', {
          cwd: config.workspaceRoot,
          timeout: 15000,
          maxBuffer: 512 * 1024,
        });
        return {
          ok: true,
          stdout,
          stderr,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function createGitStatusTool(config: AppConfig): Tool {
  return {
    definition: {
      name: 'git_status',
      description: 'Read git status output for the current repository.',
      inputSchema: {
        type: 'object',
        properties: {
          short: { type: 'boolean' },
        },
      },
    },
    async execute(input) {
      try {
        const args = ['status'];
        if (input.short !== false) {
          args.push('--short');
        }
        const { stdout, stderr } = await execFile('git', args, {
          cwd: config.workspaceRoot,
          timeout: 15000,
          maxBuffer: 512 * 1024,
        });
        return { ok: true, stdout, stderr };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function createGitLogTool(config: AppConfig): Tool {
  return {
    definition: {
      name: 'git_log',
      description: 'Read recent git log entries for the current repository.',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          path: { type: 'string' },
        },
      },
    },
    async execute(input) {
      try {
        const count = Math.max(1, Math.min(50, Number(input.count ?? 10)));
        const args = ['log', '--oneline', `-n${count}`];
        if (typeof input.path === 'string' && input.path.trim()) {
          args.push('--', input.path.trim());
        }
        const { stdout, stderr } = await execFile('git', args, {
          cwd: config.workspaceRoot,
          timeout: 15000,
          maxBuffer: 512 * 1024,
        });
        return { ok: true, stdout, stderr };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function createGitShowTool(config: AppConfig): Tool {
  return {
    definition: {
      name: 'git_show',
      description: 'Read git show output for a commit or a file at a commit.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['ref'],
      },
    },
    async execute(input) {
      try {
        const ref = sanitizeGitToken(String(input.ref ?? ''));
        const targetPath = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '';
        const args = targetPath ? ['show', `${ref}:${targetPath}`] : ['show', '--stat', '--oneline', ref];
        const { stdout, stderr } = await execFile('git', args, {
          cwd: config.workspaceRoot,
          timeout: 15000,
          maxBuffer: 512 * 1024,
        });
        return { ok: true, stdout, stderr };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function createGitDiffBaseTool(config: AppConfig): Tool {
  return {
    definition: {
      name: 'git_diff_base',
      description: 'Read git diff output against a chosen base ref.',
      inputSchema: {
        type: 'object',
        properties: {
          baseRef: { type: 'string' },
          targetRef: { type: 'string' },
          path: { type: 'string' },
        },
      },
    },
    async execute(input) {
      try {
        const baseRef = sanitizeGitToken(String(input.baseRef ?? 'HEAD~1'));
        const targetRef = sanitizeGitToken(String(input.targetRef ?? 'HEAD'));
        const args = ['diff', '--no-ext-diff', '--minimal', `${baseRef}...${targetRef}`];
        if (typeof input.path === 'string' && input.path.trim()) {
          args.push('--', input.path.trim());
        }
        const { stdout, stderr } = await execFile('git', args, {
          cwd: config.workspaceRoot,
          timeout: 15000,
          maxBuffer: 512 * 1024,
        });
        return { ok: true, stdout, stderr };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function sanitizeGitToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[a-zA-Z0-9_./:@^~-]+$/.test(trimmed)) {
    throw new Error(`Invalid git token: ${value}`);
  }

  return trimmed;
}

async function walkFiles(root: string, currentDir: string, excludePatterns: string[]): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(root, absolutePath) || entry.name;
    if (excludePatterns.some((pattern) => minimatch(relativePath, pattern, { dot: true }))) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolutePath, excludePatterns)));
    } else {
      files.push(relativePath);
    }
  }

  return files;
}
