import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { VerifyCommand, VerifyFailure } from './index.js';

const exec = promisify(execCallback);

export async function executeVerifierCommands(
  config: AppConfig,
  policy: PolicyEngine,
  commands: VerifyCommand[],
): Promise<VerifyFailure[]> {
  const failures: VerifyFailure[] = [];
  for (const step of commands) {
    try {
      policy.assertShellCommand(step.command);
      await exec(step.command, {
        cwd: config.workspaceRoot,
        env: policy.filterShellEnv(),
        timeout: step.timeoutMs,
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
        name: step.name,
        command: step.command,
        source: step.source,
        exitCode: typeof execError.code === 'number' ? execError.code : null,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message,
        retryable: true,
        blocking: !step.optional,
      });
    }
  }

  return failures;
}
