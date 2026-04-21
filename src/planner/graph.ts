import type { PlannerAccessMode, PlannerPlan, PlannerState, PlannerStep } from './types.js';

export interface PlannerExecutionEdge {
  from: string;
  to: string;
  type: 'dependency' | 'must_run_after' | 'conflict' | 'fallback';
}

export interface PlannerExecutionNode {
  stepId: string;
  title: string;
  kind: PlannerStep['kind'];
  accessMode: PlannerAccessMode;
  fileScope: string[];
  conflictsWith: string[];
  dependencies: string[];
  mustRunAfter: string[];
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
    dependencies: step.dependencies,
    mustRunAfter: step.mustRunAfter ?? [],
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
  }

  const seenConflictEdges = new Set<string>();
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    if (!left) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];
      if (!right || !nodesConflict(left, right)) {
        continue;
      }

      const explicitLeft = left.conflictsWith.includes(right.stepId);
      const explicitRight = right.conflictsWith.includes(left.stepId);
      const from = explicitRight ? right.stepId : left.stepId;
      const to = explicitRight ? left.stepId : right.stepId;
      const key = `${from}->${to}`;
      if (!seenConflictEdges.has(key)) {
        edges.push({ from, to, type: 'conflict' });
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
  const reasons: string[] = [];
  for (const dependency of step.dependencies) {
    if (plan.steps.find((candidate) => candidate.id === dependency)?.status !== 'DONE') {
      reasons.push(`dependency:${dependency}`);
    }
  }

  const node = graph.nodes.find((candidate) => candidate.stepId === step.id);
  if (node) {
    for (const predecessor of node.mustRunAfter) {
      if (plan.steps.find((candidate) => candidate.id === predecessor)?.status !== 'DONE') {
        reasons.push(`must_run_after:${predecessor}`);
      }
    }
  }

  for (const edge of graph.edges) {
    if (edge.to !== step.id || edge.type !== 'conflict') {
      continue;
    }
    if (plan.steps.find((candidate) => candidate.id === edge.from)?.status !== 'DONE') {
      reasons.push(`conflict:${edge.from}`);
    }
  }

  return reasons;
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

function nodesConflict(
  left: { stepId: string; accessMode: PlannerAccessMode; fileScope: string[] },
  right: { stepId: string; accessMode: PlannerAccessMode; fileScope: string[] },
): boolean {
  if (left.accessMode === 'verify' || right.accessMode === 'verify') {
    return false;
  }
  if (left.accessMode === 'read' && right.accessMode === 'read') {
    return false;
  }
  if (left.fileScope.length === 0 || right.fileScope.length === 0) {
    return left.accessMode === 'write' || right.accessMode === 'write';
  }

  const rightScope = new Set(right.fileScope);
  return left.fileScope.some((file) => rightScope.has(file));
}

function computeExecutionWavesFromEdges(nodes: PlannerExecutionNode[], edges: PlannerExecutionEdge[]): PlannerExecutionWave[] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.stepId, 0);
    dependents.set(node.stepId, []);
  }
  for (const edge of edges) {
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
