import path from 'node:path';
import { minimatch } from 'minimatch';
import type { AppConfig } from '../config/schema.js';

export class PolicyEngine {
  public constructor(private readonly config: AppConfig) {}

  public assertReadable(targetPath: string): void {
    this.assertPathAccess(targetPath, false);
  }

  public assertWritable(targetPath: string): void {
    this.assertPathAccess(targetPath, true);
  }

  public assertShellCommand(command: string): void {
    const shell = this.config.policy.shell;
    if (!shell.enabled) {
      throw new Error('Shell execution is disabled by policy');
    }

    const normalizedCommand = command.trim().toLowerCase();
    const tokens = normalizedCommand.split(/\s+/);
    const binary = path.basename(tokens[0] ?? '');
    if (shell.denyCommands.includes(binary)) {
      throw new Error(`Command ${binary} is blocked by policy`);
    }

    for (const pattern of shell.denyPatterns) {
      if (normalizedCommand.includes(pattern.toLowerCase())) {
        throw new Error(`Command matched blocked pattern: ${pattern}`);
      }
    }
  }

  public filterShellEnv(): NodeJS.ProcessEnv {
    if (this.config.policy.shell.inheritEnv) {
      return {
        ...process.env,
        ...this.config.project.env,
      };
    }

    const env: NodeJS.ProcessEnv = {};
    for (const key of this.config.policy.shell.allowEnv) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }

    for (const [key, value] of Object.entries(this.config.project.env)) {
      env[key] = value;
    }

    return env;
  }

  public isSensitive(targetPath: string): boolean {
    const relativePath = this.toRelativePath(targetPath);
    return this.config.context.sensitive.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
  }

  private assertPathAccess(targetPath: string, requireWrite: boolean): void {
    const relativePath = this.toRelativePath(targetPath);

    if (this.matchesAny(relativePath, this.config.policy.path.deny)) {
      throw new Error(`Access denied for ${relativePath}`);
    }

    if (requireWrite) {
      if (!this.matchesAny(relativePath, this.config.policy.path.readWrite)) {
        throw new Error(`Write access denied for ${relativePath}`);
      }
      return;
    }

    if (
      this.matchesAny(relativePath, this.config.policy.path.readWrite) ||
      this.matchesAny(relativePath, this.config.policy.path.readOnly)
    ) {
      return;
    }

    throw new Error(`Read access denied for ${relativePath}`);
  }

  private toRelativePath(targetPath: string): string {
    const absolutePath = path.resolve(targetPath);
    const relativePath = path.relative(this.config.workspaceRoot, absolutePath);
    if (relativePath.startsWith('..')) {
      return absolutePath;
    }

    return relativePath || '.';
  }

  private matchesAny(targetPath: string, patterns: string[]): boolean {
    return patterns.some((pattern) => {
      const normalizedPattern = pattern.startsWith('~')
        ? path.join(process.env.HOME ?? '', pattern.slice(1))
        : pattern;
      if (path.isAbsolute(normalizedPattern)) {
        return targetPath === normalizedPattern || targetPath.startsWith(`${normalizedPattern}${path.sep}`);
      }

      if (normalizedPattern === '.') {
        return !path.isAbsolute(targetPath);
      }

      return minimatch(targetPath, normalizedPattern, { dot: true });
    });
  }
}
