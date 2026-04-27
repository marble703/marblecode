import type { PlannerEventRecord, PlannerViewModel } from '../planner/view-model.js';

export { loadPlannerView, type PlannerEventRecord, type PlannerViewModel } from '../planner/view-model.js';

export function formatPlannerView(view: PlannerViewModel): string {
  const lines: string[] = [
    `Session: ${view.sessionDir}`,
    `Outcome: ${view.outcome}`,
    `Phase: ${view.phase}`,
    `Execution phase: ${view.executionPhase}`,
    `Strategy: ${view.strategy}    Epoch: ${view.epoch}`,
    `Plan revision: ${view.planRevision}`,
    `Plan partial: ${view.planIsPartial ? 'yes' : 'no'}`,
    `Planning horizon: ${view.planningHorizonWaveCount ?? '(none)'}`,
    `Current step: ${view.currentStepId ?? '(none)'}`,
    `Active steps: ${view.activeStepIds.join(', ') || '(none)'}`,
    `Ready steps: ${view.readyStepIds.join(', ') || '(none)'}`,
    `Failed steps: ${view.failedStepIds.join(', ') || '(none)'}`,
    `Blocked steps: ${view.blockedStepIds.join(', ') || '(none)'}`,
    `Degraded steps: ${view.degradedStepIds.join(', ') || '(none)'}`,
    `Execution waves: ${view.executionWaves.length > 0 ? view.executionWaves.map((wave) => `${wave.index}:${wave.stepIds.join(',')}`).join(' | ') : '(none)'}`,
    `Current wave: ${view.currentWaveStepIds.join(', ') || '(none)'}`,
    `Last completed wave: ${view.lastCompletedWaveStepIds.join(', ') || '(none)'}`,
    `Conflicts: ${view.conflictEdges.length > 0 ? view.conflictEdges.map((edge) => `${edge.from}->${edge.to}(${edge.domain ?? edge.reason})`).join(', ') : '(none)'}`,
    `Fallbacks: ${view.fallbackEdges.length > 0 ? view.fallbackEdges.map((edge) => `${edge.from}->${edge.to}`).join(', ') : '(none)'}`,
    `Locks: ${view.lockEntries.length > 0 ? view.lockEntries.map((entry) => `${entry.path}:${entry.mode}:${entry.ownerStepId}`).join(', ') : '(none)'}`,
    `Recovery: ${view.recoveryStepId ? `${view.recoveryStepId}${view.recoveryReason ? ` ${view.recoveryReason}` : ''}` : '(none)'}`,
    `Plan deltas: ${view.planDeltas.length > 0 ? view.planDeltas.map((delta) => `${delta.nextRevision}:${delta.addedStepIds.join(',') || '(none)'}`).join(' | ') : '(none)'}`,
    `Latest feedback: ${view.latestFeedback ? `${view.latestFeedback.executionEpoch}:${view.latestFeedback.undeclaredChangedFiles.join(',') || 'none'}${view.latestFeedback.triggerReplan ? ' replan' : ''}` : '(none)'}`,
    `Replan rejections: ${view.replanRejections.length > 0 ? view.replanRejections.map((item) => `${item.stepId}`).join(', ') : '(none)'}`,
    `Summary: ${view.summary}`,
    '',
    'Plan Steps:',
  ];

  for (const [index, step] of view.steps.entries()) {
    lines.push(`${index + 1}. [${step.status}] ${step.title} (${step.kind})`);
    lines.push(`   attempts: ${step.attempts}${step.executionState ? ` state=${step.executionState}` : ''}`);
    if (step.details) {
      lines.push(`   ${step.details}`);
    }
    if (step.relatedFiles.length > 0) {
      lines.push(`   files: ${step.relatedFiles.join(', ')}`);
    }
    if (step.children.length > 0) {
      lines.push(`   subtasks: ${step.children.join(', ')}`);
    }
    if (step.assignee) {
      lines.push(`   assignee: ${step.assignee}`);
    }
    if (step.failureKind || step.lastError) {
      lines.push(`   failure: ${step.failureKind ?? 'unknown'}${step.lastError ? ` ${step.lastError}` : ''}`);
    }
  }

  lines.push('', 'Execution Timeline:');
  for (const event of view.events) {
    lines.push(`- ${renderPlannerEvent(event)}`);
  }

  lines.push('', 'Subtask Results:');
  if (view.subtaskEvents.length === 0) {
    lines.push('- none recorded yet');
  } else {
    for (const event of view.subtaskEvents) {
      lines.push(`- ${renderPlannerEvent(event)}`);
    }
  }

  lines.push('', 'Planner Log Summary:');
  lines.push(`- terminal: ${view.terminalSummary}`);
  if (view.consistencyErrors.length > 0) {
    lines.push(`- consistency errors: ${view.consistencyErrors.join('; ')}`);
  }

  return lines.join('\n');
}

export function renderPlannerEvent(event: PlannerEventRecord): string {
  const type = String(event.type ?? 'event');
  if (type === 'plan_set') {
    return `plan set (revision ${String(event.revision ?? '')}, ${String(event.stepCount ?? '')} steps)`;
  }
  if (type === 'plan_step_updated') {
    return `${String(event.stepId ?? '')} -> ${String(event.status ?? '')}${event.message ? ` (${String(event.message)})` : ''}`;
  }
  if (type === 'tool_result') {
    return `tool ${String(event.tool ?? '')}: ${String(event.ok ?? '')}`;
  }
  if (type === 'planner_invalid_output') {
    return `invalid output retry ${String(event.attempt ?? '')}/${String(event.maxAttempts ?? '')}: ${String(event.error ?? '')}`;
  }
  if (type === 'planner_model_retry') {
    return `model retry ${String(event.attempt ?? '')}/${String(event.maxAttempts ?? '')} after ${String(event.delayMs ?? '')}ms: ${String(event.reason ?? '')}`;
  }
  if (type === 'planner_model_fallback') {
    return `planner model fallback ${String(event.fromModelAlias ?? '')} -> ${String(event.toModelAlias ?? '')}`;
  }
  if (type === 'planner_finished') {
    return `finished ${String(event.outcome ?? '')}: ${String(event.message ?? '')}`;
  }
  if (type === 'planner_execution_started') {
    return 'subtask execution started';
  }
  if (type === 'planner_execution_finished') {
    return `subtask execution finished: ${String(event.outcome ?? '')}`;
  }
  if (type === 'plan_appended') {
    return `plan appended (revision ${String(event.revision ?? '')}, ${String(event.stepCount ?? '')} steps)`;
  }
  if (type === 'planner_partial_execution_completed') {
    return `partial execution window completed (revision ${String(event.revision ?? '')})`;
  }
  if (type === 'planner_execution_window_completed') {
    return `execution window completed (${String(event.executedWaveCount ?? '')} wave)`;
  }
  if (type === 'execution_feedback_undeclared_files') {
    return `execution feedback undeclared files: ${Array.isArray(event.undeclaredFiles) ? event.undeclaredFiles.join(', ') : ''}`;
  }
  if (type === 'execution_feedback_verify_failed') {
    return `execution feedback verify failed: ${String(event.stepId ?? '')}`;
  }
  if (type === 'execution_feedback_replan_scope') {
    return `execution feedback replan scope: ${Array.isArray(event.affectedStepIds) ? event.affectedStepIds.join(', ') : ''}`;
  }
  if (type === 'subtask_retry_scheduled') {
    return `${String(event.stepId ?? '')} retry scheduled ${String(event.attempt ?? '')}/${String(event.maxAttempts ?? '')}: ${String(event.reason ?? '')}`;
  }
  if (type === 'subtask_retry_started') {
    return `${String(event.stepId ?? '')} retry started (${String(event.modelAlias ?? '')}) attempt=${String(event.attempt ?? '')}`;
  }
  if (type === 'subtask_fallback_started') {
    return `${String(event.stepId ?? '')} fallback ${String(event.fromModelAlias ?? '')} -> ${String(event.toModelAlias ?? '')}`;
  }
  if (type === 'subtask_fallback_activated') {
    return `${String(event.failedStepId ?? '')} activated fallback ${String(event.fallbackStepId ?? '')}: ${String(event.reason ?? '')}`;
  }
  if (type === 'subtask_degraded') {
    return `${String(event.stepId ?? '')} degraded: ${String(event.reason ?? '')}`;
  }
  if (type === 'planner_failed') {
    return `failed: ${String(event.reason ?? '')}`;
  }
  if (type === 'subtask_started') {
    const alias = event.modelAlias ? `/${String(event.modelAlias)}` : '';
    return `${String(event.stepId ?? '')} started (${String(event.executor ?? '')}${alias})`;
  }
  if (type === 'subtask_completed') {
    const files = Array.isArray(event.changedFiles) && event.changedFiles.length > 0 ? ` files=${event.changedFiles.join(',')}` : '';
    const alias = event.modelAlias ? `/${String(event.modelAlias)}` : '';
    const sessionDir = event.sessionDir ? ` session=${String(event.sessionDir)}` : '';
    return `${String(event.stepId ?? '')} completed (${String(event.executor ?? '')}${alias})${files}${sessionDir}`;
  }
  if (type === 'subtask_failed') {
    const alias = event.modelAlias ? `/${String(event.modelAlias)}` : '';
    return `${String(event.stepId ?? '')} failed (${String(event.executor ?? '')}${alias}): ${String(event.message ?? event.reason ?? '')}`;
  }
  if (type === 'subtask_skipped') {
    return `${String(event.stepId ?? '')} skipped: ${String(event.reason ?? '')}`;
  }
  if (type === 'subtask_verify_failed') {
    return `${String(event.stepId ?? '')} verify failed`;
  }
  if (type === 'subtask_replanned') {
    return `${String(event.stepId ?? '')} replanned revision ${String(event.revision ?? '')}`;
  }
  if (type === 'subtask_replan_failed') {
    return `${String(event.stepId ?? '')} replan failed: ${String(event.reason ?? '')}`;
  }
  if (type === 'subtask_blocked') {
    return `${String(event.stepId ?? '')} blocked: ${String(event.reason ?? '')}`;
  }
  if (type === 'planner_started' || type === 'planner_resumed' || type === 'planner_replanned') {
    return `${type}: ${String(event.prompt ?? '')}`;
  }
  return `${type}: ${JSON.stringify(event)}`;
}
