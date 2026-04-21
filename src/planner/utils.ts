import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import type { PlannerFailureKind } from './types.js';

export function countSnippetLines(snippet: string): number {
  return snippet.split(/\r?\n/).filter((line) => line.length > 0).length || 1;
}

export function mergeStringLists(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

export function normalizePlannerFilePath(workspaceRoot: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const directCandidate = path.resolve(workspaceRoot, normalized);
  if (existsSync(directCandidate)) {
    return normalized;
  }

  const anchors = ['src/', 'tests/', '.marblecode/', 'package.json'];
  for (const anchor of anchors) {
    const index = normalized.indexOf(anchor);
    if (index < 0) {
      continue;
    }

    const suffix = normalized.slice(index);
    if (existsSync(path.resolve(workspaceRoot, suffix))) {
      return suffix;
    }
  }

  return normalized;
}

export function buildPlannerModelAliasCandidates(config: AppConfig, primaryAlias: string): string[] {
  return [...new Set([primaryAlias, config.routing.defaultModel])].filter(Boolean);
}

export function shouldFallbackPlannerModel(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /access forbidden|forbidden|model not found|unsupported model|permission|not authorized|upstream_error/.test(message);
}

export function resolveSubtaskFallbackModel(config: AppConfig, primaryModelAlias: string): string | null {
  const fallback = config.routing.subtaskFallbackModel ?? config.routing.defaultModel;
  if (!fallback || fallback === primaryModelAlias) {
    return null;
  }

  return config.models[fallback] ? fallback : null;
}

export function deriveFailureKind(message: string): PlannerFailureKind {
  const normalized = message.toLowerCase();
  if (/dependency|blocked/.test(normalized)) {
    return 'dependency';
  }
  if (/policy|denied|forbidden/.test(normalized)) {
    return 'policy';
  }
  if (/verify|test|syntax/.test(normalized)) {
    return 'verify';
  }
  if (/conflict/.test(normalized)) {
    return 'conflict';
  }
  if (/tool/.test(normalized)) {
    return 'tool';
  }
  return 'model';
}
