import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';

export interface ContextInput {
  prompt: string;
  explicitFiles: string[];
  pastedSnippets: string[];
}

export interface ContextItem {
  path: string;
  reason: string;
  source: 'explicit' | 'recent' | 'keyword' | 'pasted';
  excerpt: string;
  score: number;
  sensitivity: 'normal' | 'sensitive';
  warning?: string;
}

export interface ContextBundle {
  items: ContextItem[];
  totalChars: number;
}

export async function buildContext(input: ContextInput, config: AppConfig, policy: PolicyEngine): Promise<ContextBundle> {
  const items: ContextItem[] = [];
  const seen = new Set<string>();

  for (const [index, snippet] of input.pastedSnippets.entries()) {
    items.push({
      path: `[Pasted ~${countSnippetLines(snippet)} lines #${index + 1}]`,
      reason: 'User pasted code directly into the request context.',
      source: 'pasted',
      excerpt: snippet,
      score: 1,
      sensitivity: 'normal',
    });
  }

  for (const file of input.explicitFiles) {
    const absolutePath = path.resolve(config.workspaceRoot, file);
    const relativePath = path.relative(config.workspaceRoot, absolutePath);
    if (isExcluded(relativePath, config.context.exclude)) {
      continue;
    }

    policy.assertReadable(absolutePath);

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

  const keywordCandidates = await collectKeywordMatches(config.workspaceRoot, input.prompt, config.context.exclude, config.context.sensitive);
  for (const candidate of keywordCandidates) {
    if (items.length >= config.context.maxFiles) {
      break;
    }

    if (seen.has(candidate.path)) {
      continue;
    }

    const absolutePath = path.resolve(config.workspaceRoot, candidate.path);
    policy.assertReadable(absolutePath);
    const excerpt = await safeReadSnippet(absolutePath, config.context.maxChars);
    items.push({
      path: candidate.path,
      reason: `Matched prompt keywords: ${candidate.matches.join(', ')}`,
      source: 'keyword',
      excerpt,
      score: candidate.score,
      sensitivity: 'normal',
    });
    seen.add(candidate.path);
  }

  const recentFiles = await collectRecentFiles(config.workspaceRoot, config.context.exclude, config.context.recentFileCount * 2);
  for (const candidate of recentFiles) {
    if (items.length >= config.context.maxFiles) {
      break;
    }

    if (seen.has(candidate.path) || isExcluded(candidate.path, config.context.sensitive)) {
      continue;
    }

    const absolutePath = path.resolve(config.workspaceRoot, candidate.path);
    policy.assertReadable(absolutePath);
    const excerpt = await safeReadSnippet(absolutePath, config.context.maxChars);
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

async function collectKeywordMatches(
  root: string,
  prompt: string,
  excludePatterns: string[],
  sensitivePatterns: string[],
): Promise<Array<{ path: string; score: number; matches: string[] }>> {
  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) {
    return [];
  }

  const files = await walk(root, root, excludePatterns);
  const matches: Array<{ path: string; score: number; matches: string[] }> = [];

  for (const file of files) {
    if (isExcluded(file, sensitivePatterns)) {
      continue;
    }

    const absolutePath = path.resolve(root, file);
    let content = '';
    try {
      content = await safeReadSnippet(absolutePath, 4000);
    } catch {
      continue;
    }

    const lowerPath = file.toLowerCase();
    const lowerContent = content.toLowerCase();
    const matchedKeywords = keywords.filter((keyword) => lowerPath.includes(keyword) || lowerContent.includes(keyword));
    if (matchedKeywords.length === 0) {
      continue;
    }

    const pathBonus = matchedKeywords.filter((keyword) => lowerPath.includes(keyword)).length * 0.5;
    matches.push({
      path: file,
      score: matchedKeywords.length + pathBonus,
      matches: matchedKeywords,
    });
  }

  return matches.sort((left, right) => right.score - left.score).slice(0, 4);
}

function extractKeywords(prompt: string): string[] {
  const asciiTokens = prompt
    .toLowerCase()
    .match(/[a-z0-9_./-]{3,}/g) ?? [];
  const cjkTokens = prompt.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'file', 'code', '修复', '修改']);
  const tokens = [...asciiTokens, ...cjkTokens.map((token) => token.toLowerCase())]
    .filter((token) => !stopWords.has(token))
    .slice(0, 12);

  return [...new Set(tokens)];
}

function countSnippetLines(snippet: string): number {
  return snippet.split(/\r?\n/).filter((line) => line.length > 0).length || 1;
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
