import {
  formatContextLength,
  isMachineContextTooSmall,
  minimumMachineContextLength
} from './contextLength';
import {
  supportedThinkingLevel,
  type ThinkingPolicy
} from './thinking';

interface LoadedModel {
  name: string;
  contextLength?: number;
}

type ModelMetadataLookup = (model: string) => Promise<unknown>;

interface OllamaModelList {
  models?: readonly unknown[];
}

export interface OllamaDiagnosticsConfiguration {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type OllamaDiagnosticsConfigurationSource =
  | 'used-provider-group'
  | 'resolved-provider-group'
  | 'workspace-settings';

export interface OllamaDiagnosticsConfigurationSelection {
  configuration: OllamaDiagnosticsConfiguration;
  source: OllamaDiagnosticsConfigurationSource;
}

export class OllamaDiagnosticsConfigurationTracker {
  private lastResolvedConfiguration: OllamaDiagnosticsConfiguration | undefined;
  private lastUsedConfiguration: OllamaDiagnosticsConfiguration | undefined;

  recordResolved(configuration: OllamaDiagnosticsConfiguration): void {
    this.lastResolvedConfiguration = copyConfiguration(configuration);
  }

  recordUsed(configuration: OllamaDiagnosticsConfiguration): void {
    this.lastUsedConfiguration = copyConfiguration(configuration);
  }

  select(workspaceConfiguration: OllamaDiagnosticsConfiguration): OllamaDiagnosticsConfigurationSelection {
    if (this.lastUsedConfiguration) {
      return {
        configuration: copyConfiguration(this.lastUsedConfiguration),
        source: 'used-provider-group'
      };
    }
    if (this.lastResolvedConfiguration) {
      return {
        configuration: copyConfiguration(this.lastResolvedConfiguration),
        source: 'resolved-provider-group'
      };
    }
    return {
      configuration: copyConfiguration(workspaceConfiguration),
      source: 'workspace-settings'
    };
  }
}

export interface OllamaDiagnosticsClient {
  list(): Promise<OllamaModelList>;
  ps(): Promise<OllamaModelList>;
  show(request: { model: string }): Promise<unknown>;
}

export interface OllamaModelInspection {
  availableModels?: string[];
  availableModelsError?: unknown;
  loadedModelLines?: string[];
  loadedModelsError?: unknown;
}

export function ollamaDiagnosticsClientOptions(
  host: string,
  configuredHeaders: Readonly<Record<string, unknown>>,
  request: typeof fetch
): { host: string; headers: Record<string, string>; fetch: typeof fetch } {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(configuredHeaders)) {
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return { host, headers, fetch: request };
}

export async function inspectOllamaModels(
  client: OllamaDiagnosticsClient
): Promise<OllamaModelInspection> {
  const [availableResult, loadedResult] = await Promise.allSettled([
    client.list(),
    client.ps()
  ]);
  const inspection: OllamaModelInspection = {};
  const availableModels = availableResult.status === 'fulfilled'
    ? availableResult.value.models ?? []
    : [];

  if (availableResult.status === 'fulfilled') {
    inspection.availableModels = modelNames(availableModels);
  } else {
    inspection.availableModelsError = availableResult.reason;
  }

  if (loadedResult.status === 'fulfilled') {
    inspection.loadedModelLines = await loadedModelContextDiagnosticLines(
      loadedResult.value.models ?? [],
      availableModels,
      model => client.show({ model })
    );
  } else {
    inspection.loadedModelsError = loadedResult.reason;
  }

  return inspection;
}

export async function loadedModelContextDiagnosticLines(
  models: readonly unknown[],
  availableModels: readonly unknown[],
  getModelMetadata: ModelMetadataLookup
): Promise<string[]> {
  const loadedModels = models
    .map(loadedLocalModel)
    .filter((model): model is LoadedModel => model !== undefined);

  if (loadedModels.length === 0) {
    return [
      'No local models are currently loaded. Send a prompt to a local Ollama model, then rerun `Ollama: Diagnose Models`.'
    ];
  }

  const modelLines = await Promise.all(loadedModels.map(async model => {
    let maximum = maximumSupportedContextLength(findModelMetadata(availableModels, model.name));
    if (maximum === undefined) {
      try {
        maximum = maximumSupportedContextLength(await getModelMetadata(model.name));
      } catch {
        // Maximum context metadata is optional; the runtime allocation remains useful.
      }
    }
    return loadedModelContextLine(model, maximum);
  }));

  return [
    `Ollama reports ${loadedModels.length} loaded local model(s):`,
    ...modelLines
  ];
}

function findModelMetadata(models: readonly unknown[], requestedModel: string): unknown {
  const requestedKey = modelKey(requestedModel);
  return models.find(candidate => isRecord(candidate) && [candidate.name, candidate.model].some(name =>
    typeof name === 'string' && modelKey(name) === requestedKey
  ));
}

function modelNames(models: readonly unknown[]): string[] {
  return models.flatMap(model => {
    if (!isRecord(model) || typeof model.name !== 'string' || model.name.length === 0) {
      return [];
    }
    return [model.name];
  });
}

export function maximumSupportedContextLength(metadata: unknown): number | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  for (const value of [
    positiveInteger(metadata.max_context_length),
    positiveIntegerField(metadata.details, 'max_context_length'),
    positiveInteger(metadata.context_length),
    positiveIntegerField(metadata.details, 'context_length'),
    modelInfoContextLength(metadata.model_info, 'max_context_length'),
    modelInfoContextLength(metadata.model_info, 'context_length')
  ]) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function loadedLocalModel(candidate: unknown): LoadedModel | undefined {
  if (!isRecord(candidate)) {
    return undefined;
  }

  const name = [candidate.name, candidate.model]
    .find(value => typeof value === 'string' && value.length > 0);
  if (typeof name !== 'string' || isRemoteModel(candidate, name)) {
    return undefined;
  }

  return {
    name,
    contextLength: positiveInteger(candidate.context_length)
  };
}

function loadedModelContextLine(model: LoadedModel, maximum: number | undefined): string {
  const allocation = model.contextLength === undefined
    ? 'unavailable'
    : formatContextLength(model.contextLength);
  const maximumContext = maximum === undefined
    ? 'unavailable'
    : formatContextLength(maximum);
  const warningSuffix = model.contextLength !== undefined && isMachineContextTooSmall(model.contextLength)
    ? `; WARNING: runtime allocation is below the recommended ${formatContextLength(minimumMachineContextLength)}`
    : '';

  return `- ${model.name}: runtime context allocation: ${allocation}; maximum supported context: ${maximumContext}${warningSuffix}`;
}

function isRemoteModel(model: Record<string, unknown>, name: string): boolean {
  if (typeof model.remote_host === 'string' && model.remote_host.length > 0) {
    return true;
  }
  const tag = name.split(':').at(-1)?.toLowerCase() ?? '';
  return tag === 'cloud' || tag.endsWith('-cloud');
}

function modelKey(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized.endsWith(':latest')
    ? normalized.slice(0, -':latest'.length)
    : normalized;
}

function modelInfoContextLength(
  modelInfo: unknown,
  expectedKey: 'context_length' | 'max_context_length'
): number | undefined {
  const entries = modelInfo instanceof Map
    ? modelInfo.entries()
    : isRecord(modelInfo)
      ? Object.entries(modelInfo)
      : [];

  for (const [key, value] of entries) {
    const contextLength = positiveInteger(value);
    if ((key === expectedKey || key.endsWith(`.${expectedKey}`)) && contextLength !== undefined) {
      return contextLength;
    }
  }
  return undefined;
}

function positiveIntegerField(value: unknown, key: string): number | undefined {
  return isRecord(value) ? positiveInteger(value[key]) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function copyConfiguration(configuration: OllamaDiagnosticsConfiguration): OllamaDiagnosticsConfiguration {
  return {
    url: configuration.url,
    headers: { ...configuration.headers }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ModelCapabilityDiagnostic {
  readonly model: string;
  readonly capabilities?: {
    readonly toolCalling?: boolean | number;
    readonly imageInput?: boolean;
  };
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

export function modelCapabilityDiagnosticLines(
  models: readonly ModelCapabilityDiagnostic[]
): string[] {
  if (models.length === 0) {
    return [];
  }

  const lines: string[] = ['Model capabilities:'];
  let anyLacksTools = false;

  for (const model of models) {
    const toolCapability = model.capabilities?.toolCalling;
    const hasTools = typeof toolCapability === 'number' ? toolCapability > 0 : Boolean(toolCapability);
    const tools = typeof toolCapability === 'number' && toolCapability > 0
      ? `yes (up to ${toolCapability} tools)`
      : hasTools
        ? 'yes'
        : 'no';
    if (!hasTools) {
      anyLacksTools = true;
    }
    const vision = model.capabilities?.imageInput ? 'yes' : 'no';
    const inputLimit = model.maxInputTokens !== undefined
      ? formatContextLength(model.maxInputTokens)
      : 'unavailable';
    const outputLimit = model.maxOutputTokens !== undefined
      ? formatContextLength(model.maxOutputTokens)
      : 'unavailable';

    lines.push(
      `- ${model.model}: tool calling: ${tools}; vision: ${vision}; max input: ${inputLimit}; max output: ${outputLimit}`
    );
  }

  if (anyLacksTools) {
    lines.push(
      '  Note: VS Code Copilot Agent mode requires tool calling (tool calling: yes). Models without tool support do not appear in the Agent model picker; to chat with them without tools, run "Chat: Open Chat (Ask)" (workbench.action.chat.openask).'
    );
  }

  return lines;
}

export interface ThinkingDiagnosticModel {
  readonly model: string;
  readonly thinkingPolicy?: ThinkingPolicy;
  readonly defaultSource?: 'server' | 'compatibility';
}

export function thinkingDiagnosticLines(
  models: readonly ThinkingDiagnosticModel[],
  configuredThinkingLevels?: unknown
): string[] {
  const configuredMap = isRecord(configuredThinkingLevels) ? configuredThinkingLevels : undefined;
  if (models.length === 0) {
    return [];
  }

  const lines: string[] = ['Thinking settings:'];
  for (const model of models) {
    const policy = model.thinkingPolicy;
    const rawOverride = configuredMap && Object.hasOwn(configuredMap, model.model)
      ? configuredMap[model.model]
      : undefined;
    if (!policy) {
      const override = rawOverride === undefined ? 'none' : `${formatThinkingValue(rawOverride)} (ignored)`;
      lines.push(
        `- ${model.model}: configurable thinking values unavailable; configured override: ${override}; think will be omitted to use server default`
      );
      continue;
    }
    const effective = supportedThinkingLevel(policy, rawOverride);
    const defaultLabel = model.defaultSource === 'server'
      ? `server-advertised default: ${formatThinkingValue(policy.defaultLevel)}`
      : model.defaultSource === 'compatibility'
        ? `compatibility fallback default: ${formatThinkingValue(policy.defaultLevel)}`
        : `default: ${formatThinkingValue(policy.defaultLevel)}`;

    const supportedList = `supported values: [${policy.levels.map(formatThinkingValue).join(', ')}]`;

    let overrideStatus: string;
    if (rawOverride === undefined) {
      overrideStatus = 'configured override: none; think will be omitted to use server default';
    } else if (effective !== undefined) {
      overrideStatus = `configured override: ${formatThinkingValue(rawOverride)}; effective setting for next request: ${formatThinkingValue(effective)}`;
    } else {
      overrideStatus = `configured override: ${formatThinkingValue(rawOverride)} (unsupported, ignored); think will be omitted to use server default`;
    }

    lines.push(`- ${model.model}: ${supportedList}; ${defaultLabel}; ${overrideStatus}`);
  }

  return lines;
}

function formatThinkingValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return String(value);
}
