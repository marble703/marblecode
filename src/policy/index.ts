import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { AppConfig } from '../config/schema.js';

interface PolicyEngineOptions {
  grantedReadPaths?: string[];
  grantedWritePaths?: string[];
  restrictWritePaths?: boolean;
  writePathValidator?: (targetPath: string) => void;
}

export class PolicyEngine {
  private readonly grantedReadPaths: string[];
  private readonly grantedWritePaths: string[];
  private readonly restrictWritePaths: boolean;
  private readonly writePathValidator: ((targetPath: string) => void) | null;

  public constructor(
    private readonly config: AppConfig,
    options: PolicyEngineOptions = {},
  ) {
    this.grantedReadPaths = (options.grantedReadPaths ?? []).map((entry) => this.resolvePolicyPath(path.resolve(this.config.workspaceRoot, entry)));
    this.grantedWritePaths = (options.grantedWritePaths ?? [])
      .map((entry) => this.resolvePolicyPath(path.resolve(this.config.workspaceRoot, entry)))
      .filter((entry) => this.isWithinWorkspace(entry));
    this.restrictWritePaths = options.restrictWritePaths ?? false;
    this.writePathValidator = options.writePathValidator ?? null;
  }

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

    const rawCommand = command.trim();
    const normalizedCommand = rawCommand.toLowerCase();
    if (!rawCommand) {
      throw new Error('Shell command cannot be empty');
    }

    if (/\r|\n/.test(rawCommand)) {
      throw new Error('Multi-line shell commands are blocked by policy');
    }

    const blockedShellSyntax = ['&&', '||', ';', '|', '>', '<', '$(', '`'];
    const blockedSyntax = blockedShellSyntax.find((fragment) => rawCommand.includes(fragment));
    if (blockedSyntax) {
      throw new Error(`Command matched blocked shell syntax: ${blockedSyntax}`);
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rawCommand)) {
      throw new Error('Inline environment variable assignments are blocked by policy');
    }

    const tokens = normalizedCommand.split(/\s+/);
    const binary = path.basename(tokens[0] ?? '');
    if (shell.denyCommands.includes(binary) || ['sh', 'bash', 'zsh', 'fish', 'ksh'].includes(binary)) {
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
    const relativePath = this.toRelativePath(this.resolvePolicyPath(targetPath));
    return this.config.context.sensitive.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
  }

  public isAutoDenied(targetPath: string): boolean {
    const relativePath = this.toRelativePath(this.resolvePolicyPath(targetPath));
    return (this.config.context.autoDeny ?? []).some((pattern) => minimatch(relativePath, pattern, { dot: true }));
  }

  private assertPathAccess(targetPath: string, requireWrite: boolean): void {
    const absolutePath = path.resolve(targetPath);
    const resolvedPath = this.resolvePolicyPath(absolutePath);
    const relativePath = this.toRelativePath(resolvedPath);

    if (!requireWrite && this.isGranted(resolvedPath, this.grantedReadPaths)) {
      return;
    }

    if (requireWrite && this.isGranted(resolvedPath, this.grantedWritePaths)) {
      this.writePathValidator?.(resolvedPath);
      return;
    }

    if (!requireWrite && this.isAutoDenied(resolvedPath)) {
      throw new Error(`Auto read access blocked for ${relativePath}. Provide it explicitly with --file or /files to grant access.`);
    }

    if (requireWrite && this.isAutoDenied(resolvedPath)) {
      throw new Error(`Auto write access blocked for ${relativePath}. Provide it explicitly with --file or /files to grant access.`);
    }

    if (this.matchesAny(relativePath, this.config.policy.path.deny)) {
      throw new Error(`Access denied for ${relativePath}`);
    }

    if (requireWrite) {
      if (this.restrictWritePaths) {
        throw new Error(`Write access denied for ${relativePath}. This task is restricted to explicitly granted paths.`);
      }
      if (!this.matchesAny(relativePath, this.config.policy.path.readWrite)) {
        throw new Error(`Write access denied for ${relativePath}`);
      }
      this.writePathValidator?.(resolvedPath);
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

  private isGranted(targetPath: string, grantedPaths: string[]): boolean {
    return grantedPaths.some((grantedPath) => targetPath === grantedPath || targetPath.startsWith(`${grantedPath}${path.sep}`));
  }

  private isWithinWorkspace(targetPath: string): boolean {
    const relativePath = path.relative(this.config.workspaceRoot, targetPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  }

  private resolvePolicyPath(targetPath: string): string {
    const absolutePath = path.resolve(targetPath);
    let current = absolutePath;
    while (!existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolutePath;
      }
      current = parent;
    }

    let resolvedBase: string;
    try {
      resolvedBase = realpathSync.native(current);
    } catch {
      return absolutePath;
    }

    const suffix = path.relative(current, absolutePath);
    return suffix ? path.resolve(resolvedBase, suffix) : resolvedBase;
  }
}
