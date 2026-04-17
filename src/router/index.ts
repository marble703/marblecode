import type { AppConfig } from '../config/schema.js';

export interface RouteDecision {
  modelAlias: string;
  intent: 'question' | 'code' | 'planning';
  maxSteps: number;
  maxAutoRepairAttempts: number;
}

export function routeTask(prompt: string, config: AppConfig): RouteDecision {
  const lowerPrompt = prompt.toLowerCase();
  const codeKeywords = ['fix', 'modify', 'change', 'refactor', 'implement', 'edit', 'patch', 'bug', '修复', '修改', '重构', '实现'];
  const planningKeywords = ['plan', 'design', 'architecture', 'strategy', 'roadmap', '规划', '设计', '架构', '方案'];

  const isPlanning = planningKeywords.some((keyword) => lowerPrompt.includes(keyword));
  const isCode = codeKeywords.some((keyword) => lowerPrompt.includes(keyword));

  let intent: RouteDecision['intent'] = 'question';
  let modelAlias = config.routing.defaultModel;

  if (isPlanning) {
    intent = 'planning';
    modelAlias = config.routing.planningModel;
  } else if (isCode) {
    intent = 'code';
    modelAlias = config.routing.codeModel;
  }

  return {
    modelAlias,
    intent,
    maxSteps: config.routing.maxSteps,
    maxAutoRepairAttempts: config.routing.maxAutoRepairAttempts,
  };
}
