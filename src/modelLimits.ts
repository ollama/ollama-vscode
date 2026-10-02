export interface ModelTokenLimits {
  maxInputTokens: number;
  maxOutputTokens: number;
}

export function resolveMaxContextLength(
  providerValue: unknown,
  settingValue: unknown
): number | undefined {
  return positiveInteger(providerValue) ?? positiveInteger(settingValue);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function calculateModelTokenLimits(
  contextWindow: number | undefined,
  explicitMaxInputTokens: number | undefined,
  explicitMaxOutputTokens: number | undefined,
  configuredMaxContextLength: number | undefined,
  fallbackContextWindow: number,
  defaultMaxOutputTokens: number
): ModelTokenLimits {
  const discoveredContextWindow = contextWindow
    ?? (explicitMaxInputTokens === undefined ? fallbackContextWindow : undefined);

  if (discoveredContextWindow === undefined) {
    const maxInputTokens = explicitMaxInputTokens ?? fallbackContextWindow;
    const maxOutputTokens = explicitMaxOutputTokens ?? defaultMaxOutputTokens;
    if (configuredMaxContextLength === undefined
      || maxInputTokens + maxOutputTokens <= configuredMaxContextLength) {
      return { maxInputTokens, maxOutputTokens };
    }

    const cappedOutputTokens = outputTokenLimit(
      configuredMaxContextLength,
      maxOutputTokens,
      defaultMaxOutputTokens
    );
    return {
      maxInputTokens: Math.min(maxInputTokens, configuredMaxContextLength - cappedOutputTokens),
      maxOutputTokens: cappedOutputTokens
    };
  }

  const effectiveContextWindow = configuredMaxContextLength === undefined
    ? discoveredContextWindow
    : Math.min(configuredMaxContextLength, discoveredContextWindow);

  const maxOutputTokens = outputTokenLimit(
    effectiveContextWindow,
    explicitMaxOutputTokens,
    defaultMaxOutputTokens
  );
  return {
    maxInputTokens: effectiveContextWindow - maxOutputTokens,
    maxOutputTokens
  };
}

function outputTokenLimit(
  contextWindow: number,
  configuredOutputLimit: number | undefined,
  defaultMaxOutputTokens: number
): number {
  if (contextWindow <= 1) {
    return 0;
  }

  return Math.min(
    configuredOutputLimit ?? defaultMaxOutputTokens,
    contextWindow - 1
  );
}
