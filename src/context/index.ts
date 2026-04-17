import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { AppConfig } from '../config/schema.js';

export interface ContextInput {
  prompt: string;
  explicitFiles: string[];
}

export interface ContextItem {
  path: string;
  reason: string;
  source: 'explicit' | 'recent';
  excerpt: string;
  score: number;
  sensitivity: 'normal' | 'sensitive';
  warning?: string;
}

export interface ContextBundle {
  items: ContextItem[];
  totalChars: number;
}

export async function buildContext(input: ContextInput, config: AppConfig): Promise<ContextBundle> {
  const items: ContextItem[] = [];
  const seen = new Set<string>();

  for (const file of input.explicitFiles) {
    const absolutePath = path.resolve(config.workspaceRoot, file);
    const relativePath = path.relative(config.workspaceRoot, absolutePath);
    if (isExcluded(relativePath, config.context.exclude)) {
      continue;
    }

    const sensitive = isExcluded(relativePath, config.context.sensitive);
    const excerpt = await safeReadSnippet(absolutePath, config.context.maxChars);
    const explicitItem: ContextItem = {
      path: relativePath,
      reason: 'User explicitly requested this file.',
      source: 'explicit',
      excerpt,
      score: 1,
      sensitivity: sensitive ? 'sensitive' : 'normal',
      ...(sensitive ? { warning: 'Sensitive file explicitly opened in read-only mode.' } : {}),
    };
    items.push(explicitItem);
    seen.add(relativePath);
  }

  const recentFiles = await collectRecentFiles(config.workspaceRoot, config.context.exclude, config.context.recentFileCount * 2);
  for (const candidate of recentFiles) {
    if (items.length >= config.context.maxFiles) {
      break;
    }

    if (seen.has(candidate.path) || isExcluded(candidate.path, config.context.sensitive)) {
      continue;
    }

    const excerpt = await safeReadSnippet(path.resolve(config.workspaceRoot, candidate.path), config.context.maxChars);
    items.push({
      path: candidate.path,
      reason: 'Recently modified file.',
      source: 'recent',
      excerpt,
      score: 0.4,
      sensitivity: 'normal',
    });
    seen.add(candidate.path);
  }

  const boundedItems: ContextItem[] = [];
  let totalChars = 0;
  for (const item of items) {
    if (boundedItems.length >= config.context.maxFiles) {
      break;
    }

    if (totalChars + item.excerpt.length > config.context.maxChars) {
      break;
    }

    boundedItems.push(item);
    totalChars += item.excerpt.length;
  }

  return {
    items: boundedItems,
    totalChars,
  };
}

function isExcluded(targetPath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(targetPath, pattern, { dot: true }));
}

async function safeReadSnippet(filePath: string, limit: number): Promise<string> {
  const content = await readFile(filePath, 'utf8');
  return content.slice(0, limit);
}

async function collectRecentFiles(root: string, excludePatterns: string[], limit: number): Promise<Array<{ path: string; mtimeMs: number }>> {
  const entries = await walk(root, root, excludePatterns);
  const stats = await Promise.all(
    entries.map(async (entry) => ({
      path: entry,
      mtimeMs: (await stat(path.resolve(root, entry))).mtimeMs,
    })),
  );

  return stats.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
}

async function walk(root: string, currentDir: string, excludePatterns: string[]): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(root, absolutePath) || entry.name;
    if (isExcluded(relativePath, excludePatterns)) {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...(await walk(root, absolutePath, excludePatterns)));
      continue;
    }

    results.push(relativePath);
  }

  return results;
}
