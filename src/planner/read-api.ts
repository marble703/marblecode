import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { listRecentSessionEntries } from '../session/index.js';
import {
  loadPlannerEvents,
  loadPlannerSessionSummary,
  loadPlannerView,
  PLANNER_READ_MODEL_SCHEMA_VERSION,
  type PlannerEventsView,
  type PlannerReadModelSchemaVersion,
  type PlannerSessionSummary,
  type PlannerViewModel,
} from './view-model.js';

export interface PlannerSessionListView {
  schemaVersion: PlannerReadModelSchemaVersion;
  sessions: PlannerSessionSummary[];
}

export interface PlannerSessionDetailView {
  schemaVersion: PlannerReadModelSchemaVersion;
  summary: PlannerSessionSummary;
  view: PlannerViewModel;
  events: PlannerEventsView;
}

export async function listPlannerSessionSummaries(
  config: AppConfig,
  limit = 8,
): Promise<PlannerSessionListView> {
  const entries = await listRecentSessionEntries(config, Math.max(limit * 3, limit));
  const plannerEntries = entries.filter((entry) => entry.isPlanner).slice(0, limit);
  const sessions = await Promise.all(
    plannerEntries.map((entry) => loadPlannerSessionSummary(entry.id, entry.dir)),
  );
  return {
    schemaVersion: PLANNER_READ_MODEL_SCHEMA_VERSION,
    sessions,
  };
}

export async function loadPlannerSessionDetail(sessionDir: string): Promise<PlannerSessionDetailView> {
  const [view, events] = await Promise.all([
    loadPlannerView(sessionDir),
    loadPlannerEvents(sessionDir),
  ]);

  return {
    schemaVersion: PLANNER_READ_MODEL_SCHEMA_VERSION,
    summary: {
      schemaVersion: PLANNER_READ_MODEL_SCHEMA_VERSION,
      id: path.basename(sessionDir),
      dir: sessionDir,
      isPlanner: true,
      summary: view.summary,
      outcome: view.outcome,
      phase: view.phase,
      currentStepId: view.currentStepId,
      executionPhase: view.executionPhase,
      planRevision: view.planRevision,
      planIsPartial: view.planIsPartial,
      degradedCompletion: view.degradedCompletion,
      blockedStepIds: view.blockedStepIds,
      degradedStepIds: view.degradedStepIds,
    },
    view,
    events,
  };
}
