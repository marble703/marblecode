import { exec as execCallback } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { Tool } from './types.js';

const exec = promisify(execCallback);

export function createBuiltinTools(config: AppConfig, policy: PolicyEngine): Tool[] {
  return [
    createReadFileTool(config, policy),
    createListFilesTool(config, policy),
    createSearchTextTool(config, policy),
    createRunShellTool(config, policy),
    createGitDiffTool(config),
  ];
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
        const files = await walkFiles(config.workspaceRoot, targetDir, config.context.exclude);
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
        },
        required: ['pattern'],
      },
    },
    async execute(input) {
      try {
        const regex = new RegExp(String(input.pattern), 'g');
        const files = await walkFiles(config.workspaceRoot, config.workspaceRoot, config.context.exclude);
        const matches: Array<{ path: string; count: number }> = [];
        for (const file of files) {
          const targetPath = path.resolve(config.workspaceRoot, file);
          policy.assertReadable(targetPath);
          if (policy.isSensitive(targetPath)) {
            continue;
          }

          const content = await readFile(targetPath, 'utf8');
          const count = [...content.matchAll(regex)].length;
          if (count > 0) {
            matches.push({ path: file, count });
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
