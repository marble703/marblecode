import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { minimatch } from 'minimatch';

export function matchesPathPatterns(targetPath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(targetPath, pattern, { dot: true }));
}

export async function walkRelativeFiles(root: string, currentDir: string, excludePatterns: string[]): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(root, absolutePath) || entry.name;
    if (matchesPathPatterns(relativePath, excludePatterns)) {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...(await walkRelativeFiles(root, absolutePath, excludePatterns)));
      continue;
    }

    results.push(relativePath);
  }

  return results;
}
