import type { AppConfig } from '../config/schema.js';

export interface RouteDecision {
  modelAlias: string;
  intent: 'question' | 'code' | 'planning';
  maxSteps: number;
  maxAutoRepairAttempts: number;
}

export function routeTask(prompt: string, config: AppConfig): RouteDecision {
  const normalizedPrompt = prompt.trim();
  const lowerPrompt = normalizedPrompt.toLowerCase();

  const codeKeywords = [
    'fix',
    'modify',
    'change',
    'refactor',
    'implement',
    'edit',
    'patch',
    'bug',
    'debug',
    'code',
    'file',
    'src/',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.json',
    '修复',
    '修改',
    '重构',
    '实现',
    '编辑',
    '补丁',
    '代码',
    '文件',
  ];
  const planningKeywords = [
    'plan',
    'design',
    'architecture',
    'strategy',
    'roadmap',
    '规划',
    '设计',
    '架构',
    '方案',
  ];

  const hasPlanningKeyword = planningKeywords.some((keyword) => lowerPrompt.includes(keyword));
  const hasExplicitPlanningIntent =
    /(make|create|write|give|need|draft)?\s*(a\s+)?(plan|design|architecture|strategy|roadmap)\b/i.test(normalizedPrompt) ||
    /(给我|提供|输出)?\s*(一个)?\s*(规划|设计|架构|方案)/i.test(normalizedPrompt);
  const isPlanning = hasPlanningKeyword || hasExplicitPlanningIntent;

  const hasCodeKeyword = codeKeywords.some((keyword) => lowerPrompt.includes(keyword));
  const hasFilePathSignal = /(?:(?:^|\s)(?:src|app|lib|test|tests)\/\S+)|(?:\.[a-z0-9]+\b)/i.test(normalizedPrompt);
  const hasQuotedFileSignal = /[`'\"][^`'\"]+\.[a-z0-9]+[`'\"]/i.test(normalizedPrompt);
  const hasExplicitCodeEditIntent =
    /(fix|modify|change|refactor|implement|edit|patch|debug|修复|修改|重构|实现|编辑|补丁)/i.test(normalizedPrompt);
  const isCode = hasCodeKeyword || hasFilePathSignal || hasQuotedFileSignal || hasExplicitCodeEditIntent;

  let intent: RouteDecision['intent'] = 'question';
  let modelAlias = config.routing.defaultModel;

  if (!normalizedPrompt) {
    return {
      modelAlias,
      intent,
      maxSteps: config.routing.maxSteps,
      maxAutoRepairAttempts: config.routing.maxAutoRepairAttempts,
    };
  }

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
