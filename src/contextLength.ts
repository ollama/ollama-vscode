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
    if (contextLength !== undefined) {
      return contextLength;
    }

    if (settledBeforeCheck) {
      return undefined;
    }
    if (isRequestSettled()) {
      // The request settled while /api/ps was in flight. Check once more now
      // that Ollama has finished loading the model.
      continue;
    }
    if (!await waitForNextCheck()) {
      return undefined;
    }
  }
}

export function isMachineContextTooSmall(contextLength: number): boolean {
  return contextLength < minimumMachineContextLength;
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
