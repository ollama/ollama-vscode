export type ThinkingLevel = boolean | string;

export interface ThinkingPolicy {
  levels: readonly ThinkingLevel[];
  defaultLevel: ThinkingLevel;
}

// Keep this inventory aligned with the model documentation published on
// ollama.com/library. These mappings were last verified on 2026-08-11:
// - https://ollama.com/library/gpt-oss
// - https://ollama.com/library/deepseek-v4-flash
// - https://ollama.com/library/deepseek-v4-pro
// - https://ollama.com/library/glm-5.2

/**
 * Prefer the exact values and default advertised by /api/show. Older servers
 * omit this metadata, so retain the documented mappings for known models only.
 */
export function thinkingPolicy(modelName: string, family?: string, metadata?: unknown): ThinkingPolicy | undefined {
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null) {
      return undefined;
    }
    const { values, default: defaultLevel } = metadata as { values?: unknown; default?: unknown };
    if (!Array.isArray(values) || !values.every(isThinkingLevel) || !isThinkingLevel(defaultLevel)) {
      return undefined;
    }
    const levels = [...new Set(values)];
    // A single value is not a configurable control (e.g. [false] means no thinking).
    return levels.length > 1 && levels.includes(defaultLevel) ? { levels, defaultLevel } : undefined;
  }

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
      levels: [false, 'high', 'max'],
      defaultLevel: false
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
  return typeof value === 'boolean' || (typeof value === 'string' && value.trim().length > 0);
}

export function supportedThinkingLevel(
  policy: ThinkingPolicy | undefined,
  value: unknown
): ThinkingLevel | undefined {
  if (!policy) {
    return undefined;
  }
  if (!isThinkingLevel(value)) {
    return undefined;
  }
  return policy.levels.includes(value) ? value : undefined;
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
