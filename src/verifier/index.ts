import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';

const exec = promisify(execCallback);

export interface VerifyFailure {
  stage: 'verifier';
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  retryable: boolean;
}

export interface VerifyResult {
  success: boolean;
  failures: VerifyFailure[];
}

export async function runVerifier(config: AppConfig, policy: PolicyEngine): Promise<VerifyResult> {
  if (!config.verifier.enabled || config.verifier.commands.length === 0) {
    return {
      success: true,
      failures: [],
    };
  }

  const failures: VerifyFailure[] = [];
  for (const command of config.verifier.commands) {
    try {
      policy.assertShellCommand(command);
      await exec(command, {
        cwd: config.workspaceRoot,
        env: policy.filterShellEnv(),
        timeout: config.verifier.timeoutMs,
        maxBuffer: config.policy.shell.maxBufferBytes,
      });
    } catch (error) {
      const execError = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      failures.push({
        stage: 'verifier',
        command,
        exitCode: typeof execError.code === 'number' ? execError.code : null,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message,
        retryable: true,
      });
    }
  }

  return {
    success: failures.length === 0,
    failures,
  };
}
