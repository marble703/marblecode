import { readFile } from 'node:fs/promises';
import { minimatch } from 'minimatch';

export interface MarkdownVerifierStep {
  name: string;
  command: string;
  description: string;
  when: string;
  paths: string[];
  platforms: string[];
  optional: boolean;
  timeoutMs: number | null;
}

export async function loadMarkdownVerifierSteps(filePath: string): Promise<MarkdownVerifierStep[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  return parseVerifierMarkdown(content);
}

export function selectMarkdownVerifierSteps(
  steps: MarkdownVerifierStep[],
  changedFiles: string[],
  platform: NodeJS.Platform,
): MarkdownVerifierStep[] {
  const platformMatched = steps.filter((step) => matchesPlatform(step, platform));
  const defaultSteps = platformMatched.filter((step) => step.paths.length === 0);
  const pathMatched = platformMatched.filter((step) =>
    step.paths.length > 0 && changedFiles.some((file) => step.paths.some((pattern) => minimatch(file, pattern, { dot: true }))),
  );

  if (changedFiles.length === 0) {
    return dedupeSteps(defaultSteps.length > 0 ? defaultSteps : platformMatched);
  }

  return dedupeSteps([...defaultSteps, ...pathMatched]);
}

function parseVerifierMarkdown(content: string): MarkdownVerifierStep[] {
  const headingPattern = /^##+\s+(.+)$/gm;
  const headings = Array.from(content.matchAll(headingPattern));
  const steps: MarkdownVerifierStep[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    if (!match) {
      continue;
    }
    const name = match[1]?.trim();
    const start = match.index ?? 0;
    const bodyStart = start + match[0].length;
    const bodyEnd = headings[index + 1]?.index ?? content.length;
    if (!name) {
      continue;
    }

    const step = parseVerifierSection(name, content.slice(bodyStart, bodyEnd));
    if (step) {
      steps.push(step);
    }
  }

  return steps;
}

function parseVerifierSection(name: string, body: string): MarkdownVerifierStep | null {
  let command = '';
  const descriptionLines: string[] = [];
  const whenLines: string[] = [];
  const paths = new Set<string>();
  const platforms = new Set<string>();
  let optional = false;
  let timeoutMs: number | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === '---') {
      continue;
    }

    const metadataMatch = line.match(/^[-*]\s*([A-Za-z][A-Za-z0-9 _-]*)\s*:\s*(.+)$/);
    if (!metadataMatch) {
      descriptionLines.push(line);
      continue;
    }

    const key = normalizeKey(metadataMatch[1] ?? '');
    const value = metadataMatch[2]?.trim() ?? '';

    if (key === 'run' || key === 'command' || key === 'cmd') {
      command = value;
      continue;
    }

    if (key === 'when') {
      whenLines.push(value);
      continue;
    }

    if (key === 'path' || key === 'paths' || key === 'file' || key === 'files') {
      for (const item of splitList(value)) {
        paths.add(item);
      }
      continue;
    }

    if (key === 'platform' || key === 'platforms') {
      for (const item of splitList(value)) {
        platforms.add(item.toLowerCase());
      }
      continue;
    }

    if (key === 'optional') {
      optional = /^(true|yes|1)$/i.test(value);
      continue;
    }

    if (key === 'timeout' || key === 'timeoutms') {
      timeoutMs = parseDuration(value);
      continue;
    }

    descriptionLines.push(line);
  }

  if (!command) {
    return null;
  }

  return {
    name,
    command,
    description: descriptionLines.join(' '),
    when: whenLines.join(' '),
    paths: [...paths],
    platforms: [...platforms],
    optional,
    timeoutMs,
  };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDuration(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const match = normalized.match(/^(\d+)(ms|s|m)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const amount = Number(match[1]);
  if (match[2] === 'ms') {
    return amount;
  }

  if (match[2] === 's') {
    return amount * 1000;
  }

  return amount * 60 * 1000;
}

function matchesPlatform(step: MarkdownVerifierStep, platform: NodeJS.Platform): boolean {
  if (step.platforms.length === 0) {
    return true;
  }

  return step.platforms.some((value) => value === platform || value === 'all' || value === '*');
}

function dedupeSteps(steps: MarkdownVerifierStep[]): MarkdownVerifierStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = `${step.name}\n${step.command}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
