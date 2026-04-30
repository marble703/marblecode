import type { PlannerAccessMode, PlannerPlan, PlannerState, PlannerStep } from './types.js';

export interface PlannerBlockedReason {
  kind: 'dependency' | 'must_run_after' | 'fallback_inactive' | 'conflict';
  stepId: string;
  blockedByStepId: string;
  message: string;
  edgeType: 'dependency' | 'must_run_after' | 'conflict' | 'fallback';
  conflictReason?: NonNullable<PlannerExecutionEdge['reason']>;
  conflictDomain?: string;
}

export interface PlannerConflictSummary {
  fromStepId: string;
  toStepId: string;
  reason: NonNullable<PlannerExecutionEdge['reason']>;
  domain?: string;
  message: string;
}

export interface PlannerExecutionEdge {
  from: string;
  to: string;
  type: 'dependency' | 'must_run_after' | 'conflict' | 'fallback';
  reason?: 'explicit' | 'conflict_domain' | 'file_scope' | 'unknown_write_scope';
  domain?: string;
}

export interface PlannerExecutionNode {
  stepId: string;
  title: string;
  kind: PlannerStep['kind'];
  accessMode: PlannerAccessMode;
  fileScope: string[];
  conflictsWith: string[];
  conflictDomains: string[];
  dependencies: string[];
  mustRunAfter: string[];
  fallbackStepIds: string[];
}

export interface PlannerExecutionWave {
  index: number;
  stepIds: string[];
}

export interface PlannerExecutionGraph {
  version: '1';
  revision: number;
  nodes: PlannerExecutionNode[];
  edges: PlannerExecutionEdge[];
  waves: PlannerExecutionWave[];
}

export function buildExecutionGraph(plan: PlannerPlan, conflictPolicy: 'serial' | 'fail' = 'serial'): PlannerExecutionGraph {
  const nodes = plan.steps.map((step, index) => ({
    stepId: step.id,
    title: step.title,
    kind: step.kind,
    accessMode: derivePlannerAccessMode(step),
    fileScope: derivePlannerFileScope(step),
    conflictsWith: derivePlannerConflicts(step),
    conflictDomains: derivePlannerConflictDomains(step),
    dependencies: step.dependencies,
    mustRunAfter: step.mustRunAfter ?? [],
    fallbackStepIds: step.fallbackStepIds ?? [],
    order: index,
  }));
  const edges: PlannerExecutionEdge[] = [];

  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      edges.push({ from: dependency, to: node.stepId, type: 'dependency' });
    }
    for (const predecessor of node.mustRunAfter) {
      edges.push({ from: predecessor, to: node.stepId, type: 'must_run_after' });
    }
    for (const fallback of node.fallbackStepIds) {
      edges.push({ from: node.stepId, to: fallback, type: 'fallback' });
    }
  }

  const seenConflictEdges = new Set<string>();
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    if (!left) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];
      const conflict = right ? getNodeConflict(left, right) : null;
      if (!right || !conflict) {
        continue;
      }

      const explicitLeft = left.conflictsWith.includes(right.stepId);
      const explicitRight = right.conflictsWith.includes(left.stepId);
      const from = explicitRight ? right.stepId : left.stepId;
      const to = explicitRight ? left.stepId : right.stepId;
      const reason: NonNullable<PlannerExecutionEdge['reason']> = explicitLeft || explicitRight ? 'explicit' : conflict.reason ?? 'file_scope';
      const key = `${from}->${to}`;
      if (!seenConflictEdges.has(key)) {
        edges.push({ from, to, type: 'conflict', reason, ...(reason === 'conflict_domain' && conflict.domain ? { domain: conflict.domain } : {}) });
        seenConflictEdges.add(key);
      }
    }
  }

  const waves = computeExecutionWavesFromEdges(nodes.map(({ order, ...node }) => node), edges);
  return {
    version: '1',
    revision: plan.revision,
    nodes: nodes.map(({ order, ...node }) => node),
    edges,
    waves,
  };
}

export function hasDependencyCycle(graph: PlannerExecutionGraph): boolean {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    inDegree.set(node.stepId, 0);
    dependents.set(node.stepId, []);
  }
  for (const edge of graph.edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    const next = dependents.get(edge.from);
    if (next) {
      next.push(edge.to);
    }
  }

  const queue = graph.nodes.map((node) => node.stepId).filter((id) => (inDegree.get(id) ?? 0) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    visited += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const degree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, degree);
      if (degree === 0) {
        queue.push(dependent);
      }
    }
  }

  return visited !== graph.nodes.length;
}

export function getReadyStepIds(plan: PlannerPlan, state: PlannerState, graph: PlannerExecutionGraph): string[] {
  const ready = new Set(state.readyStepIds);
  if (ready.size > 0) {
    return [...ready].filter((stepId) => graph.nodes.some((node) => node.stepId === stepId));
  }

  return plan.steps
    .filter((step) => step.status !== 'DONE' && step.status !== 'FAILED')
    .filter((step) => getBlockedReasons(step, plan, graph).length === 0)
    .map((step) => step.id);
}

export function getBlockedReasons(step: PlannerStep, plan: PlannerPlan, graph: PlannerExecutionGraph): string[] {
  return getStructuredBlockedReasons(step, plan, graph).map((reason) => `${reason.kind}:${reason.blockedByStepId}`);
}

export function getStructuredBlockedReasons(step: PlannerStep, plan: PlannerPlan, graph: PlannerExecutionGraph): PlannerBlockedReason[] {
  const reasons: PlannerBlockedReason[] = [];
  for (const dependency of step.dependencies) {
    if (!dependencySatisfied(step, dependency, plan, graph)) {
      reasons.push({
        kind: 'dependency',
        stepId: step.id,
        blockedByStepId: dependency,
        edgeType: 'dependency',
        message: `${step.id} is blocked by dependency ${dependency}`,
      });
    }
  }

  const node = graph.nodes.find((candidate) => candidate.stepId === step.id);
  if (node) {
    for (const predecessor of node.mustRunAfter) {
      const predecessorStatus = plan.steps.find((candidate) => candidate.id === predecessor)?.status;
      if (predecessorStatus !== 'DONE' && !fallbackReplacementSatisfied(plan, graph, predecessor)) {
        reasons.push({
          kind: 'must_run_after',
          stepId: step.id,
          blockedByStepId: predecessor,
          edgeType: 'must_run_after',
          message: `${step.id} must run after ${predecessor}`,
        });
      }
    }
  }

  for (const edge of graph.edges) {
    if (edge.type === 'fallback' && edge.to === step.id) {
      if (plan.steps.find((candidate) => candidate.id === edge.from)?.status !== 'FAILED') {
        reasons.push({
          kind: 'fallback_inactive',
          stepId: step.id,
          blockedByStepId: edge.from,
          edgeType: 'fallback',
          message: `${step.id} is waiting for fallback source ${edge.from} to fail before activation`,
        });
      }
      continue;
    }
    if (edge.to !== step.id || edge.type !== 'conflict') {
      continue;
    }
    const predecessorStatus = plan.steps.find((candidate) => candidate.id === edge.from)?.status;
    const fallbackFromFailedPredecessor = predecessorStatus === 'FAILED'
      && graph.edges.some((candidate) => candidate.type === 'fallback' && candidate.from === edge.from && candidate.to === step.id);
    if (predecessorStatus !== 'DONE' && !fallbackFromFailedPredecessor) {
      reasons.push({
        kind: 'conflict',
        stepId: step.id,
        blockedByStepId: edge.from,
        edgeType: 'conflict',
        message: `${step.id} is blocked by conflict with ${edge.from}${edge.reason === 'conflict_domain' && edge.domain ? ` (${edge.domain})` : ''}`,
        ...(edge.reason ? { conflictReason: edge.reason } : {}),
        ...(edge.domain ? { conflictDomain: edge.domain } : {}),
      });
    }
  }

  return reasons;
}

export function findPendingConflictSummary(plan: PlannerPlan, graph: PlannerExecutionGraph): PlannerConflictSummary | null {
  const pending = new Set(plan.steps.filter((step) => step.status !== 'DONE' && step.status !== 'FAILED').map((step) => step.id));
  const edge = graph.edges.find((candidate) => candidate.type === 'conflict' && pending.has(candidate.from) && pending.has(candidate.to));
  if (!edge) {
    return null;
  }

  return {
    fromStepId: edge.from,
    toStepId: edge.to,
    reason: edge.reason ?? 'file_scope',
    ...(edge.domain ? { domain: edge.domain } : {}),
    message: `Planner execution conflict detected between ${edge.from} and ${edge.to}.`,
  };
}

function dependencySatisfied(step: PlannerStep, dependencyId: string, plan: PlannerPlan, graph: PlannerExecutionGraph): boolean {
  const dependency = plan.steps.find((candidate) => candidate.id === dependencyId);
  if (!dependency) {
    return false;
  }
  if (dependency.status === 'DONE') {
    return true;
  }
  if (fallbackReplacementSatisfied(plan, graph, dependencyId)) {
    return true;
  }
  if (step.kind === 'verify') {
    return false;
  }

  const tolerance = step.dependencyTolerances?.[dependencyId] ?? 'required';
  return tolerance === 'degrade' && dependency.status === 'FAILED' && dependency.failureTolerance === 'degrade';
}

export function derivePlannerAccessMode(step: PlannerStep): PlannerAccessMode {
  if (step.accessMode) {
    return step.accessMode;
  }
  if (step.kind === 'verify') {
    return 'verify';
  }
  if (step.kind === 'search' || step.kind === 'note') {
    return 'read';
  }
  return 'write';
}

export function derivePlannerFileScope(step: PlannerStep): string[] {
  const scope = step.fileScope ?? step.producesFiles ?? step.relatedFiles ?? [];
  return [...new Set(scope)];
}

export function derivePlannerConflicts(step: PlannerStep): string[] {
  return [...new Set(step.conflictsWith ?? [])];
}

export function derivePlannerConflictDomains(step: PlannerStep): string[] {
  return [...new Set(step.conflictDomains ?? [])];
}

function getNodeConflict(
  left: { stepId: string; accessMode: PlannerAccessMode; fileScope: string[]; conflictDomains: string[] },
  right: { stepId: string; accessMode: PlannerAccessMode; fileScope: string[]; conflictDomains: string[] },
): { reason: PlannerExecutionEdge['reason']; domain?: string } | null {
  if (left.accessMode === 'verify' || right.accessMode === 'verify') {
    return null;
  }
  if (left.accessMode === 'read' && right.accessMode === 'read') {
    return null;
  }

  const rightDomains = new Set(right.conflictDomains);
  const sharedDomain = left.conflictDomains.find((domain) => rightDomains.has(domain));
  if (sharedDomain) {
    return { reason: 'conflict_domain', domain: sharedDomain };
  }
  if (left.fileScope.length === 0 || right.fileScope.length === 0) {
    return left.accessMode === 'write' || right.accessMode === 'write'
      ? { reason: 'unknown_write_scope' }
      : null;
  }

  const rightScope = new Set(right.fileScope);
  return left.fileScope.some((file) => rightScope.has(file)) ? { reason: 'file_scope' } : null;
}

function fallbackReplacementSatisfied(plan: PlannerPlan, graph: PlannerExecutionGraph, sourceStepId: string): boolean {
  return graph.edges.some((edge) => edge.type === 'fallback'
    && edge.from === sourceStepId
    && plan.steps.find((candidate) => candidate.id === edge.to)?.status === 'DONE');
}

function computeExecutionWavesFromEdges(nodes: PlannerExecutionNode[], edges: PlannerExecutionEdge[]): PlannerExecutionWave[] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.stepId, 0);
    dependents.set(node.stepId, []);
  }
  for (const edge of edges) {
    if (edge.type === 'fallback') {
      continue;
    }
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    const next = dependents.get(edge.from);
    if (next) {
      next.push(edge.to);
    }
  }

  const remaining = new Set(nodes.map((node) => node.stepId));
  const waves: PlannerExecutionWave[] = [];
  let index = 0;
  while (remaining.size > 0) {
    const stepIds = nodes
      .map((node) => node.stepId)
      .filter((stepId) => remaining.has(stepId) && (inDegree.get(stepId) ?? 0) === 0);
    if (stepIds.length === 0) {
      break;
    }

    waves.push({ index, stepIds });
    for (const stepId of stepIds) {
      remaining.delete(stepId);
      for (const dependent of dependents.get(stepId) ?? []) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
      }
    }
    index += 1;
  }

  return waves;
}
