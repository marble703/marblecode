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
  queryTerms: string[];
  selectionSummary: string;
  candidates: ContextCandidate[];
}

export interface ContextCandidate {
  path: string;
  source: 'keyword' | 'recent';
  score: number;
  matchedTerms: string[];
  lineHints: number[];
}

const MAX_AUTO_CONTEXT_CANDIDATES = 4;
const KEYWORD_CANDIDATE_POOL = 12;
const KEYWORD_READ_LIMIT = 8000;

export async function buildContext(input: ContextInput, config: AppConfig, policy: PolicyEngine): Promise<ContextBundle> {
  const items: ContextItem[] = [];
  const candidates: ContextCandidate[] = [];
  const seen = new Set<string>();
  const pastedLabels: string[] = [];
  const queryTerms = extractQueryTerms(input.prompt, input.pastedSnippets);
  const autoExcludePatterns = [...config.context.exclude, ...config.context.autoDeny];

  for (const [index, snippet] of input.pastedSnippets.entries()) {
    const label = `[Pasted ~${countSnippetLines(snippet)} lines #${index + 1}]`;
    items.push({
      path: label,
      reason: 'User pasted code directly into the request context.',
      source: 'pasted',
      excerpt: snippet,
      score: 1,
      sensitivity: 'normal',
    });
    pastedLabels.push(label);
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

  const keywordCandidates = await collectKeywordMatches(
      config.workspaceRoot,
      queryTerms,
      autoExcludePatterns,
      config.context.sensitive,
    );
  let autoSelectedCount = 0;
  for (const candidate of keywordCandidates) {
    if (items.length >= config.context.maxFiles || autoSelectedCount >= MAX_AUTO_CONTEXT_CANDIDATES) {
      break;
    }

    if (seen.has(candidate.path)) {
      continue;
    }

    const absolutePath = path.resolve(config.workspaceRoot, candidate.path);
    policy.assertReadable(absolutePath);
    const excerpt = candidate.excerpt;
    items.push({
      path: candidate.path,
      reason: buildKeywordReason(candidate, autoSelectedCount + 1),
      source: 'keyword',
      excerpt,
      score: candidate.score,
      sensitivity: 'normal',
    });
    candidates.push({
      path: candidate.path,
      source: 'keyword',
      score: candidate.score,
      matchedTerms: candidate.matchedTerms,
      lineHints: candidate.lineHints,
    });
    seen.add(candidate.path);
    autoSelectedCount += 1;
  }

  const recentFiles = await collectRecentFiles(config.workspaceRoot, autoExcludePatterns, config.context.recentFileCount * 2);
  for (const candidate of recentFiles) {
    if (items.length >= config.context.maxFiles || autoSelectedCount >= MAX_AUTO_CONTEXT_CANDIDATES) {
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
    candidates.push({
      path: candidate.path,
      source: 'recent',
      score: 0.4,
      matchedTerms: [],
      lineHints: [],
    });
    seen.add(candidate.path);
    autoSelectedCount += 1;
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

  const boundedPaths = new Set(boundedItems.map((item) => item.path));
  const boundedCandidates = candidates.filter((candidate) => boundedPaths.has(candidate.path));

  return {
    items: boundedItems,
    totalChars,
    queryTerms,
    selectionSummary: buildSelectionSummary(input.explicitFiles, pastedLabels, queryTerms, boundedCandidates),
    candidates: boundedCandidates,
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
  queryTerms: string[],
  excludePatterns: string[],
  sensitivePatterns: string[],
): Promise<Array<{ path: string; score: number; matchedTerms: string[]; lineHints: number[]; excerpt: string }>> {
  if (queryTerms.length === 0) {
    return [];
  }

  const files = await walk(root, root, excludePatterns);
  const matches: Array<{ path: string; score: number; matchedTerms: string[]; lineHints: number[]; excerpt: string }> = [];

  for (const file of files) {
    if (isExcluded(file, sensitivePatterns)) {
      continue;
    }

    const absolutePath = path.resolve(root, file);
    let content = '';
    try {
      content = await safeReadSnippet(absolutePath, KEYWORD_READ_LIMIT);
    } catch {
      continue;
    }

    const lowerPath = file.toLowerCase();
    const lowerContent = content.toLowerCase();
    const pathMatches = queryTerms.filter((keyword) => lowerPath.includes(keyword));
    const contentMatches = queryTerms.filter((keyword) => lowerContent.includes(keyword));
    const matchedTerms = [...new Set([...pathMatches, ...contentMatches])];
    if (matchedTerms.length === 0) {
      continue;
    }

    const lineHints = findMatchingLineNumbers(content, matchedTerms);
    const basename = path.basename(lowerPath);
    const basenameBonus = matchedTerms.some((keyword) => basename.includes(keyword)) ? 4 : 0;
    const score = pathMatches.length * 8 + contentMatches.length * 3 + basenameBonus;
    matches.push({
      path: file,
      score,
      matchedTerms,
      lineHints,
      excerpt: extractRelevantSnippet(content, matchedTerms),
    });
  }

  return matches.sort((left, right) => right.score - left.score).slice(0, KEYWORD_CANDIDATE_POOL);
}

function extractQueryTerms(prompt: string, pastedSnippets: string[]): string[] {
  const promptTerms = extractKeywords(prompt);
  const snippetTerms = pastedSnippets.flatMap((snippet) => extractKeywords(snippet));
  return expandQueryTerms([...promptTerms, ...snippetTerms]).slice(0, 20);
}

function extractKeywords(prompt: string): string[] {
  const asciiTokens = prompt
    .toLowerCase()
    .match(/[a-z0-9_./-]{3,}/g) ?? [];
  const cjkRuns = prompt.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const cjkTokens = cjkRuns.flatMap((token) => expandCjkToken(token.toLowerCase()));
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'file', 'code', '修复', '修改']);
  const tokens = [...asciiTokens, ...cjkTokens]
    .flatMap((token) => token.split(/[./_-]/g))
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !stopWords.has(token))
    .slice(0, 12);

  return [...new Set(tokens)];
}

function expandQueryTerms(tokens: string[]): string[] {
  const synonyms: Record<string, string[]> = {
    路由: ['route', 'router'],
    注册: ['register', 'registration'],
    重复: ['duplicate', 'dup'],
    问题: ['bug'],
    route: ['router'],
    router: ['route'],
    register: ['registration'],
    duplicate: ['dup'],
  };

  const expanded: string[] = [];
  for (const token of tokens) {
    expanded.push(token);
    expanded.push(...(synonyms[token] ?? []));
  }

  return [...new Set(expanded)];
}

function expandCjkToken(token: string): string[] {
  if (token.length <= 2) {
    return [token];
  }

  const expanded: string[] = [token];
  for (let index = 0; index <= token.length - 2; index += 1) {
    expanded.push(token.slice(index, index + 2));
  }
  return expanded;
}

function countSnippetLines(snippet: string): number {
  return snippet.split(/\r?\n/).filter((line) => line.length > 0).length || 1;
}

function buildKeywordReason(
  candidate: { score: number; matchedTerms: string[]; lineHints: number[] },
  rank: number,
): string {
  const lineText = candidate.lineHints.length > 0 ? `; lines=${candidate.lineHints.join(',')}` : '';
  return `Auto-selected candidate #${rank}; score=${candidate.score}; matched terms: ${candidate.matchedTerms.join(', ')}${lineText}`;
}

function buildSelectionSummary(
  explicitFiles: string[],
  pastedLabels: string[],
  queryTerms: string[],
  candidates: ContextCandidate[],
): string {
  const lines = ['Context selection summary:'];
  lines.push(`- explicit files: ${explicitFiles.length > 0 ? explicitFiles.join(', ') : '(none)'}`);
  lines.push(`- pasted snippets: ${pastedLabels.length > 0 ? pastedLabels.join(', ') : '(none)'}`);
  lines.push(`- query terms: ${queryTerms.length > 0 ? queryTerms.join(', ') : '(none)'}`);

  if (candidates.length === 0) {
    lines.push('- auto-selected files: (none)');
  } else {
    lines.push('- auto-selected files:');
    for (const [index, candidate] of candidates.entries()) {
      const lineText = candidate.lineHints.length > 0 ? ` lines=${candidate.lineHints.join(',')}` : '';
      const termText = candidate.matchedTerms.length > 0 ? ` terms=${candidate.matchedTerms.join(',')}` : '';
      lines.push(`  ${index + 1}. ${candidate.path} [${candidate.source} score=${candidate.score}${termText}${lineText}]`);
    }
  }

  lines.push('- if the selected context is insufficient, use search_text, list_files, and read_file before editing.');
  return lines.join('\n');
}

function findMatchingLineNumbers(content: string, queryTerms: string[]): number[] {
  if (queryTerms.length === 0) {
    return [];
  }

  const lowerLines = content.toLowerCase().split(/\r?\n/);
  const lineNumbers: number[] = [];
  for (const [index, line] of lowerLines.entries()) {
    if (queryTerms.some((term) => line.includes(term))) {
      lineNumbers.push(index + 1);
    }
    if (lineNumbers.length >= 3) {
      break;
    }
  }

  return lineNumbers;
}

function extractRelevantSnippet(content: string, queryTerms: string[]): string {
  if (queryTerms.length === 0) {
    return content.slice(0, 1200);
  }

  const lowerContent = content.toLowerCase();
  const firstIndex = queryTerms
    .map((term) => lowerContent.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (firstIndex === undefined) {
    return content.slice(0, 1200);
  }

  const lineStart = lowerContent.lastIndexOf('\n', firstIndex - 1);
  const start = Math.max(0, lineStart - 400);
  const end = Math.min(content.length, firstIndex + 800);
  return content.slice(start, end);
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
