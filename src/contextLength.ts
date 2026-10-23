export const minimumMachineContextLength = 64 * 1024;

interface OllamaProcessModel {
  name?: unknown;
  model?: unknown;
  context_length?: unknown;
}

export function machineContextLength(
  models: readonly unknown[],
  requestedModel: string
): number | undefined {
  const requestedKey = modelKey(requestedModel);

  for (const candidate of models) {
    if (!isRecord(candidate)) {
      continue;
    }

    const model = candidate as OllamaProcessModel;
    const matches = [model.name, model.model].some(name =>
      typeof name === 'string' && modelKey(name) === requestedKey
    );
    if (matches && isPositiveInteger(model.context_length)) {
      return model.context_length;
    }
  }

  return undefined;
}

export async function waitForMachineContextLength(
  listModels: () => Promise<readonly unknown[]>,
  requestedModel: string,
  isRequestSettled: () => boolean,
  waitForNextCheck: () => Promise<boolean>
): Promise<number | undefined> {
  while (true) {
    const settledBeforeCheck = isRequestSettled();
    const contextLength = machineContextLength(await listModels(), requestedModel);
    if (settledBeforeCheck) {
      return contextLength;
    }

    if (isRequestSettled()) {
      // Ignore a result from a lookup that began before the request settled.
      // Check once more now that Ollama has finished loading the model.
      continue;
    }
    if (!await waitForNextCheck()) {
      return undefined;
    }
  }
}

export async function waitForMachineContextCheckBeforeStreaming(
  check: Promise<void>,
  waitForTimeout: () => Promise<void>,
  cancelCheck: () => void
): Promise<void> {
  let checkFinished = false;
  await Promise.race([
    check.finally(() => { checkFinished = true; }),
    waitForTimeout().then(() => {
      if (!checkFinished) {
        cancelCheck();
      }
    })
  ]);
}

export function isMachineContextTooSmall(
  contextLength: number,
  minimumContextLength = minimumMachineContextLength
): boolean {
  return contextLength < minimumContextLength;
}

export function formatContextLength(contextLength: number): string {
  return contextLength % 1024 === 0
    ? `${contextLength / 1024}K`
    : contextLength.toLocaleString('en-US');
}

function modelKey(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized.endsWith(':latest')
    ? normalized.slice(0, -':latest'.length)
    : normalized;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseContextExceededError(
  error: unknown
): { requestedTokens: number; availableTokens: number } | undefined {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
    ? error.message
    : isRecord(error) && typeof error.message === 'string'
    ? error.message
    : String(error ?? '');
  const match = message.match(
    /request\s*\((\d+)\s*tokens\)\s*exceeds\s*the\s*available\s*context\s*size\s*\((\d+)\s*tokens\)/i
  );
  if (!match) {
    return undefined;
  }
  const requestedTokens = Number(match[1]);
  const availableTokens = Number(match[2]);
  if (isPositiveInteger(requestedTokens) && isPositiveInteger(availableTokens)
    && requestedTokens > availableTokens) {
    return { requestedTokens, availableTokens };
  }
  return undefined;
}

export function formatContextExceededError(
  exceeded: { requestedTokens: number; availableTokens: number },
  contextWindow: number,
  modelName: string
): string {
  const requested = formatContextLength(exceeded.requestedTokens);
  if (exceeded.requestedTokens > contextWindow) {
    const limit = formatContextLength(contextWindow);
    return `Prompt (${requested} tokens) exceeds ${modelName}'s maximum context window (${limit}). Shorten the prompt or remove attachments to continue.`;
  }
  const allocated = formatContextLength(exceeded.availableTokens);
  return `Prompt (${requested} tokens) exceeds the allocated context window (${allocated}) for ${modelName}. Increase the context window or shorten the prompt to continue.`;
}
