import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface DiscoveredVerifierStep {
  name: string;
  command: string;
  description: string;
  when: string;
}

export async function discoverVerifierCommands(workspaceRoot: string): Promise<DiscoveredVerifierStep[]> {
  const packageSteps = await discoverPackageScripts(workspaceRoot);
  if (packageSteps.length > 0) {
    return packageSteps;
  }

  const makeSteps = await discoverMakeTargets(workspaceRoot);
  if (makeSteps.length > 0) {
    return makeSteps;
  }

  if (await fileExists(path.join(workspaceRoot, 'Cargo.toml'))) {
    return [
      {
        name: 'Cargo Tests',
        command: 'cargo test',
        description: 'Auto-discovered from Cargo.toml.',
        when: 'Rust workspace without an explicit verifier plan.',
      },
    ];
  }

  if (await fileExists(path.join(workspaceRoot, 'go.mod'))) {
    return [
      {
        name: 'Go Tests',
        command: 'go test ./...',
        description: 'Auto-discovered from go.mod.',
        when: 'Go workspace without an explicit verifier plan.',
      },
    ];
  }

  if (await hasPytestSignals(workspaceRoot)) {
    return [
      {
        name: 'Pytest',
        command: 'pytest',
        description: 'Auto-discovered from Python test configuration.',
        when: 'Python workspace without an explicit verifier plan.',
      },
    ];
  }

  return [];
}

async function discoverPackageScripts(workspaceRoot: string): Promise<DiscoveredVerifierStep[]> {
  const packagePath = path.join(workspaceRoot, 'package.json');
  const packageJson = await readOptionalJson(packagePath);
  if (!packageJson || typeof packageJson !== 'object') {
    return [];
  }

  const scripts = extractScripts(packageJson);
  if (Object.keys(scripts).length === 0) {
    return [];
  }

  const runner = await detectPackageRunner(workspaceRoot);
  if (scripts.verify) {
    return [
      {
        name: 'Package Verify',
        command: `${runner} run verify`,
        description: 'Auto-discovered from package.json scripts.verify.',
        when: 'Use the project-defined verify script when no explicit verifier plan exists.',
      },
    ];
  }

  const steps: DiscoveredVerifierStep[] = [];
  if (scripts.test) {
    steps.push({
      name: 'Package Tests',
      command: `${runner} run test`,
      description: 'Auto-discovered from package.json scripts.test.',
      when: 'Run the package test script when no explicit verifier plan exists.',
    });
  }

  if (scripts.build) {
    steps.push({
      name: 'Package Build',
      command: `${runner} run build`,
      description: 'Auto-discovered from package.json scripts.build.',
      when: 'Run the package build script when no explicit verifier plan exists.',
    });
  }

  return dedupeCommands(steps);
}

async function discoverMakeTargets(workspaceRoot: string): Promise<DiscoveredVerifierStep[]> {
  const makefilePath = await findExistingPath([
    path.join(workspaceRoot, 'Makefile'),
    path.join(workspaceRoot, 'makefile'),
  ]);
  if (!makefilePath) {
    return [];
  }

  const content = await readFile(makefilePath, 'utf8');
  const targets = new Set(Array.from(content.matchAll(/^([A-Za-z0-9_.-]+):/gm)).map((match) => match[1] ?? '').filter(Boolean));
  if (targets.has('verify')) {
    return [
      {
        name: 'Make Verify',
        command: 'make verify',
        description: 'Auto-discovered from Makefile target verify.',
        when: 'Use the project-defined verify target when no explicit verifier plan exists.',
      },
    ];
  }

  const steps: DiscoveredVerifierStep[] = [];
  if (targets.has('test')) {
    steps.push({
      name: 'Make Test',
      command: 'make test',
      description: 'Auto-discovered from Makefile target test.',
      when: 'Run make test when no explicit verifier plan exists.',
    });
  }

  if (targets.has('build')) {
    steps.push({
      name: 'Make Build',
      command: 'make build',
      description: 'Auto-discovered from Makefile target build.',
      when: 'Run make build when no explicit verifier plan exists.',
    });
  }

  return dedupeCommands(steps);
}

async function hasPytestSignals(workspaceRoot: string): Promise<boolean> {
  if (await findExistingPath([
    path.join(workspaceRoot, 'pytest.ini'),
    path.join(workspaceRoot, 'tox.ini'),
  ])) {
    return true;
  }

  const pyprojectPath = path.join(workspaceRoot, 'pyproject.toml');
  if (!(await fileExists(pyprojectPath))) {
    return false;
  }

  const content = await readFile(pyprojectPath, 'utf8');
  return /pytest|tool\.pytest|tool\.poetry/i.test(content);
}

async function detectPackageRunner(workspaceRoot: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  if (await findExistingPath([path.join(workspaceRoot, 'pnpm-lock.yaml')])) {
    return 'pnpm';
  }

  if (await findExistingPath([path.join(workspaceRoot, 'yarn.lock')])) {
    return 'yarn';
  }

  if (await findExistingPath([path.join(workspaceRoot, 'bun.lockb'), path.join(workspaceRoot, 'bun.lock')])) {
    return 'bun';
  }

  return 'npm';
}

function extractScripts(packageJson: Record<string, unknown>): Record<string, string> {
  const rawScripts = packageJson.scripts;
  if (!rawScripts || typeof rawScripts !== 'object') {
    return {};
  }

  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawScripts)) {
    if (typeof value === 'string') {
      scripts[key] = value;
    }
  }
  return scripts;
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

async function findExistingPath(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function dedupeCommands(steps: DiscoveredVerifierStep[]): DiscoveredVerifierStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    if (seen.has(step.command)) {
      return false;
    }
    seen.add(step.command);
    return true;
  });
}
