export const thinkingLevelProperty = 'thinkingLevel';

export const thinkingLevels = ['none', 'low', 'medium', 'high', 'max'] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type OllamaThinkValue = boolean | Exclude<ThinkingLevel, 'none'>;

export interface ThinkingPolicy {
  levels: readonly ThinkingLevel[];
  defaultLevel: ThinkingLevel;
}

/**
 * Return only thinking controls documented for a known Ollama model family.
 * Ollama's generic `thinking` capability does not expose the accepted values,
 * so unknown models do not receive a control rather than guessing.
 */
export function thinkingPolicy(modelName: string, family?: string): ThinkingPolicy | undefined {
  const identifiers = [modelNameWithoutTag(modelName), family]
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeIdentifier);

  if (identifiers.some(value => value === 'gpt-oss' || value === 'gptoss')) {
    return {
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'medium'
    };
  }

  if (identifiers.some(value => value === 'deepseek-v4-flash' || value === 'deepseek-v4-pro')) {
    return {
      levels: ['none', 'high', 'max'],
      defaultLevel: 'high'
    };
  }

  if (identifiers.some(value => value === 'glm-5.2' || value === 'glm5.2')) {
    return {
      levels: ['high', 'max'],
      defaultLevel: 'high'
    };
  }

  return undefined;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (thinkingLevels as readonly string[]).includes(value);
}

export function toOllamaThinkValue(level: ThinkingLevel | undefined): OllamaThinkValue | undefined {
  if (level === undefined) {
    return undefined;
  }
  return level === 'none' ? false : level;
}

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function thinkingLevelDescription(level: ThinkingLevel): string {
  switch (level) {
    case 'none': return 'Disable thinking';
    case 'low': return 'Use low thinking effort';
    case 'medium': return 'Use medium thinking effort';
    case 'high': return 'Use high thinking effort';
    case 'max': return 'Use maximum thinking effort';
  }
}

function modelNameWithoutTag(modelName: string): string {
  const cloudSuffix = ':cloud';
  const normalized = modelName.toLowerCase();
  if (normalized.endsWith(cloudSuffix)) {
    return normalized.slice(0, -cloudSuffix.length);
  }
  return normalized.split(':', 1)[0];
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}
