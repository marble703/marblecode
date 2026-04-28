import type { AppConfig } from '../config/schema.js';
import { discoverVerifierCommands } from './discover.js';
import { loadMarkdownVerifierSteps, selectMarkdownVerifierSteps } from './markdown.js';
import type { VerifyCommand } from './index.js';

export async function resolveVerifierCommands(
  config: AppConfig,
  changedFiles: string[],
  manualCommands: string[],
): Promise<VerifyCommand[]> {
  if (manualCommands.length > 0) {
    return manualCommands.map((command, index) => ({
      name: `manual-${index + 1}`,
      command,
      source: 'manual',
      description: 'CLI override verifier command.',
      when: 'Requested manually for this run.',
      paths: [],
      platforms: [],
      optional: false,
      timeoutMs: config.verifier.timeoutMs,
    }));
  }

  if (config.verifier.commands.length > 0) {
    return config.verifier.commands.map((command, index) => ({
      name: `config-${index + 1}`,
      command,
      source: 'config',
      description: 'Legacy config-defined verifier command.',
      when: 'Configured in JSON config.',
      paths: [],
      platforms: [],
      optional: false,
      timeoutMs: config.verifier.timeoutMs,
    }));
  }

  const markdownSteps = selectMarkdownVerifierSteps(
    await loadMarkdownVerifierSteps(config.verifier.path),
    changedFiles,
    process.platform,
  );
  if (markdownSteps.length > 0) {
    return markdownSteps.map((step) => ({
      name: step.name,
      command: step.command,
      source: 'markdown',
      description: step.description,
      when: step.when,
      paths: step.paths,
      platforms: step.platforms,
      optional: step.optional,
      timeoutMs: step.timeoutMs ?? config.verifier.timeoutMs,
    }));
  }

  if (!config.verifier.allowDiscovery) {
    return [];
  }

  const discoveredSteps = await discoverVerifierCommands(config.workspaceRoot);
  return discoveredSteps.map((step) => ({
    name: step.name,
    command: step.command,
    source: 'discovered',
    description: step.description,
    when: step.when,
    paths: [],
    platforms: [],
    optional: false,
    timeoutMs: config.verifier.timeoutMs,
  }));
}
