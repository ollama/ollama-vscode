export type ThinkingLevel = boolean | string;

export interface ThinkingPolicy {
  levels: readonly ThinkingLevel[];
  defaultLevel: ThinkingLevel;
}

export type LanguageModelConfigurationValue = string | boolean | number;

export interface LanguageModelConfigurationProperty {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: readonly LanguageModelConfigurationValue[];
  enumItemLabels?: readonly string[];
  default?: LanguageModelConfigurationValue;
  group?: string;
}

export interface LanguageModelConfigurationSchema {
  properties?: Record<string, LanguageModelConfigurationProperty>;
}

export interface EffectiveThinkingResolution {
  /** The validated thinking level to send to the Ollama server, or undefined to omit think. */
  thinkingLevel: ThinkingLevel | undefined;
  /** Whether the user explicitly chose an override (via dropdown or settings), or chose to clear/omit. */
  isExplicitChoice: boolean;
  /** If the choice came from Chat modelConfiguration and should be persisted to settings. */
  persistedSettingValue?: ThinkingLevel;
  shouldClearPersistedSetting?: boolean;
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

export function formatThinkingItemLabel(level: LanguageModelConfigurationValue): string {
  if (level === 'default') {
    return 'Use server default';
  }
  if (typeof level === 'boolean') {
    return String(level);
  }
  if (typeof level === 'string') {
    return level.charAt(0).toUpperCase() + level.slice(1);
  }
  return String(level);
}

export function thinkingConfigurationSchema(
  policy: ThinkingPolicy | undefined,
  configuredOverride?: unknown
): LanguageModelConfigurationSchema | undefined {
  if (!policy || policy.levels.length <= 1) {
    return undefined;
  }

  const effectiveOverride = supportedThinkingLevel(policy, configuredOverride);
  const defaultSelection: LanguageModelConfigurationValue = effectiveOverride !== undefined
    ? effectiveOverride
    : 'default';

  const enumValues: LanguageModelConfigurationValue[] = ['default', ...policy.levels];
  const enumLabels: string[] = enumValues.map(formatThinkingItemLabel);

  return {
    properties: {
      reasoningEffort: {
        type: ['string', 'boolean'],
        title: 'Thinking Effort',
        description: 'Thinking effort for this model.',
        group: 'navigation',
        enum: enumValues,
        enumItemLabels: enumLabels,
        default: defaultSelection
      }
    }
  };
}

export function extractThinkingFromModelConfiguration(modelConfiguration: unknown): unknown {
  if (!modelConfiguration || typeof modelConfiguration !== 'object' || Array.isArray(modelConfiguration)) {
    return undefined;
  }
  const config = modelConfiguration as Record<string, unknown>;
  if (Object.hasOwn(config, 'reasoningEffort')) {
    return config.reasoningEffort;
  }
  if (Object.hasOwn(config, 'thinkingLevel')) {
    return config.thinkingLevel;
  }
  if (Object.hasOwn(config, 'think')) {
    return config.think;
  }
  return undefined;
}

export function resolveEffectiveThinking(
  policy: ThinkingPolicy | undefined,
  modelConfiguration: unknown,
  configuredOverride: unknown
): EffectiveThinkingResolution {
  if (!policy) {
    return {
      thinkingLevel: undefined,
      isExplicitChoice: false
    };
  }

  const rawFromModelConfig = extractThinkingFromModelConfiguration(modelConfiguration);

  // 1. User explicitly selected from Chat dropdown
  if (rawFromModelConfig !== undefined) {
    if (rawFromModelConfig === 'default') {
      return {
        thinkingLevel: undefined,
        isExplicitChoice: true,
        shouldClearPersistedSetting: true
      };
    }

    const verified = supportedThinkingLevel(policy, rawFromModelConfig);
    if (verified !== undefined) {
      return {
        thinkingLevel: verified,
        isExplicitChoice: true,
        persistedSettingValue: verified
      };
    }

    // Unsupported value in modelConfiguration: omit think
    return {
      thinkingLevel: undefined,
      isExplicitChoice: false
    };
  }

  // 2. Fall back to settings.json override
  const effectiveSetting = supportedThinkingLevel(policy, configuredOverride);
  return {
    thinkingLevel: effectiveSetting,
    isExplicitChoice: effectiveSetting !== undefined
  };
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
