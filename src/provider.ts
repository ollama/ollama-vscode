import * as vscode from 'vscode';
import { createHash, randomUUID } from 'crypto';
import {
  Ollama,
  ChatRequest,
  ChatResponse,
  Message,
  ModelResponse,
  ShowRequest,
  ShowResponse,
  Tool,
  ToolCall
} from 'ollama';
import { toOllamaMessages, toOllamaTools } from './convert';
import {
  isOutdatedAgentModel,
  isRecommendedModel,
  OutdatedModelWarningTracker,
  type OutdatedModelWarningRequest,
  type ModelRecommendation,
  parseModelRecommendations,
  recommendedReplacement
} from './recommendations';

interface OllamaProviderConfiguration {
  url: string;
  models: string[];
  headers: Record<string, string>;
}

interface OllamaLanguageModel extends vscode.LanguageModelChatInformation {
  model: string;
  url: string;
  headers: Record<string, string>;
  recommendedReplacement?: string;
}

const defaultOllamaURL = 'http://127.0.0.1:11434';
const recommendationTimeoutMS = 2000;
const fallbackContextWindow = 32768;
const defaultMaxOutputTokens = 4096;
const defaultCharsPerToken = 4;

export interface OllamaTagsModel {
  name: string;
  model?: string;
  remote_host?: string;
  modified_at?: Date;
  size?: number;
  digest?: string;
  capabilities?: string[];
  model_info?: ModelInfo;
  details?: Partial<ModelResponse['details']> & Record<string, unknown>;
  context_length?: number;
  max_context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

interface OllamaShowResponse extends Omit<ShowResponse, 'model_info'> {
  model_info?: ModelInfo;
  context_length?: number;
  max_context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

type ModelInfo = Record<string, unknown> | Map<string, unknown>;

export interface OllamaChatMessage extends Message {
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

export interface OllamaTool extends Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

interface OllamaToolCall extends ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse extends Partial<Omit<ChatResponse, 'message'>> {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
}

interface OllamaErrorResponse {
  error?: string;
  signin_url?: string;
}

class OllamaAPIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly responseError?: string,
    readonly signinURL?: string
  ) {
    super(message);
  }
}

export class OllamaLanguageModelProvider implements vscode.LanguageModelChatProvider<OllamaLanguageModel>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly tokenCounts = new CalibratedTokenEstimator();
  private readonly outdatedModelWarnings = new OutdatedModelWarningTracker();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  constructor(private readonly output?: vscode.OutputChannel) {}

  refresh() {
    this.output?.appendLine('Refreshing Ollama language models.');
    this.changeEmitter.fire();
  }

  dispose() {
    this.changeEmitter.dispose();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<OllamaLanguageModel[]> {
    const configuration = getConfiguration(options);
    const disposables: vscode.Disposable[] = [];
    const request = createFetch(token, disposables);
    const ollama = new Ollama({
      host: configuration.url,
      headers: configuration.headers,
      fetch: request
    });
    const version = await ollama.version()
      .then(response => response.version)
      .catch(() => undefined);

    try {
      try {
        const body = await ollama.list();
        const availableModels = ((body.models ?? []) as unknown[]).filter(isOllamaTagsModel);
        const recommendations = await fetchModelRecommendations(configuration, request, token, this.output);
        const models = configuration.models.length > 0
          ? selectConfiguredModels(configuration.models, availableModels)
          : availableModels;

        const hydratedModels = await hydrateModels(ollama, models);
        const versionSuffix = version ? ` with Ollama ${version}` : '';
        const recommendationSuffix = recommendations.length > 0
          ? ` using ${recommendations.length} recommendation(s)`
          : '';
        this.output?.appendLine(
          `Providing ${models.length} Ollama model(s) from ${configuration.url}${versionSuffix}${recommendationSuffix}.`
        );

        return hydratedModels.map(({ model, show }) => this.toLanguageModel(
          model,
          show,
          configuration,
          recommendedReplacement(model.name, availableModels, recommendations),
          isRecommendedModel(model.name, recommendations)
        ));
      } catch (error) {
        throw this.userFacingError(error);
      }
    } finally {
      disposeAll(disposables);
    }
  }

  async provideLanguageModelChatResponse(
    model: OllamaLanguageModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const ollamaMessages = toOllamaMessages(messages);
    const warningRequest = this.outdatedModelWarnings.beginRequest(
      warningHistory(ollamaMessages),
      messages.some(message => message.role === vscode.LanguageModelChatMessageRole.Assistant)
    );
    let confirmed: boolean;
    try {
      confirmed = await this.confirmOutdatedModelUse(model, warningRequest, token);
    } catch (error) {
      this.outdatedModelWarnings.finishRequest(warningRequest, false);
      throw error;
    }
    if (!confirmed) {
      this.outdatedModelWarnings.finishRequest(warningRequest, false);
      this.output?.appendLine(`Cancelled chat request to ${model.model} before sending.`);
      throw new vscode.CancellationError();
    }

    const disposables: vscode.Disposable[] = [];
    const ollama = new Ollama({
      host: model.url,
      headers: model.headers,
      fetch: createFetch(token, disposables)
    });
    const tools = toOllamaTools(options.tools);
    this.output?.appendLine(`Sending chat request to ${model.model} at ${model.url}.`);
    let requestSucceeded = false;

    try {
      let promptTokenCount: number | undefined;
      const stream = await ollama.chat({
        model: model.model,
        messages: ollamaMessages,
        stream: true,
        tools: tools.length > 0 ? tools : undefined,
        options: options.modelOptions ? { ...options.modelOptions } : undefined
      } as ChatRequest & { stream: true });
      const streamDisposable = token.onCancellationRequested(() => stream.abort());
      disposables.push(streamDisposable);

      for await (const chunk of stream as AsyncIterable<ChatResponse>) {
        const response = chunk as OllamaChatResponse;
        if (typeof chunk.prompt_eval_count === 'number' && chunk.prompt_eval_count > 0) {
          promptTokenCount = chunk.prompt_eval_count;
        }

        const content = response.message?.content;
        if (content) {
          progress.report(new vscode.LanguageModelTextPart(content));
        }

        for (const toolCall of response.message?.tool_calls ?? []) {
          progress.report(new vscode.LanguageModelToolCallPart(
            toolCall.id ?? randomUUID(),
            toolCall.function.name,
            toolCall.function.arguments
          ));
        }
      }
      if (promptTokenCount !== undefined) {
        this.tokenCounts.record(model.id, messages, promptTokenCount);
      }
      requestSucceeded = true;
    } catch (error) {
      throw await this.handleChatError(model, error);
    } finally {
      this.outdatedModelWarnings.finishRequest(warningRequest, requestSucceeded);
      disposeAll(disposables);
    }
  }

  async provideTokenCount(
    model: OllamaLanguageModel,
    input: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    return this.tokenCounts.count(model.id, input);
  }

  private async handleChatError(model: OllamaLanguageModel, error: unknown): Promise<Error> {
    this.output?.appendLine(`Ollama request failed for ${model.model}: ${formatError(error)}`);

    if (isAuthError(error)) {
      const message = isCloudModel(model.model)
        ? `Run ollama signin to use ${model.model}.`
        : 'Run ollama signin and try again.';

      if (error.signinURL) {
        const action = 'Sign in to Ollama';
        const selected = await vscode.window.showErrorMessage(message, action);
        if (selected === action) {
          await vscode.env.openExternal(vscode.Uri.parse(error.signinURL));
        }
      } else {
        void vscode.window.showErrorMessage(message);
      }

      return new Error(message);
    }

    return this.userFacingError(error);
  }

  private userFacingError(error: unknown): Error {
    if (isAuthError(error)) {
      return new Error('Run ollama signin and try again.');
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async confirmOutdatedModelUse(
    model: OllamaLanguageModel,
    warningRequest: OutdatedModelWarningRequest,
    token: vscode.CancellationToken
  ): Promise<boolean> {
    if (!isOutdatedAgentModel(model.model)) {
      return true;
    }
    if (this.outdatedModelWarnings.hasShown(warningRequest, model.model)) {
      return true;
    }

    const replacement = model.recommendedReplacement;
    const guidance = replacement
      ? ` We recommend ${replacement} for stronger coding and tool use.`
      : ' We recommend choosing a newer model for stronger coding and tool use.';
    const chooseAnotherModel = 'Choose another model';
    const continueAnyway = 'Continue anyway';
    const outcome = await showWarningMessageUntilCancelled(
      `${model.model} may not work as reliably with VS Code agent tools.${guidance}`,
      [chooseAnotherModel, continueAnyway],
      token
    );
    if (outcome.kind === 'cancelled') {
      return false;
    }
    if (outcome.kind === 'error') {
      this.output?.appendLine(`Could not show model recommendation guidance: ${formatError(outcome.error)}`);
      return true;
    }
    this.outdatedModelWarnings.markShown(warningRequest, model.model);
    const selected = outcome.selected;

    if (selected === chooseAnotherModel) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.openModelPicker');
      } catch (error) {
        this.output?.appendLine(`Could not open the model picker: ${formatError(error)}`);
        try {
          await vscode.commands.executeCommand('workbench.action.chat.manage');
        } catch (fallbackError) {
          this.output?.appendLine(`Could not open model management: ${formatError(fallbackError)}`);
        }
      }
      return false;
    }

    return selected === continueAnyway || selected === undefined;
  }

  private toLanguageModel(
    model: OllamaTagsModel,
    show: OllamaShowResponse | undefined,
    configuration: OllamaProviderConfiguration,
    replacement: string | undefined,
    recommended: boolean
  ): OllamaLanguageModel {
    const capabilities = mergedCapabilities(model.capabilities, show?.capabilities);
    const name = model.name;
    const { maxInputTokens, maxOutputTokens } = modelTokenLimits(model, show);

    return {
      id: name,
      name,
      family: modelFamily(model, show),
      tooltip: recommended ? 'Recommended' : name,
      version: '1.0',
      maxInputTokens,
      maxOutputTokens,
      capabilities: {
        toolCalling: hasCapability(capabilities, 'tools', 'tool'),
        imageInput: hasCapability(capabilities, 'vision', 'image')
      },
      model: name,
      url: configuration.url,
      headers: configuration.headers,
      recommendedReplacement: replacement
    };
  }
}

function warningHistory(
  messages: readonly OllamaChatMessage[]
): string[] {
  return messages.map(message => createHash('sha256')
    .update(JSON.stringify(message))
    .digest('hex'));
}

type WarningMessageOutcome<T extends string> =
  | { kind: 'selection'; selected: T | undefined }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: unknown };

async function showWarningMessageUntilCancelled<T extends string>(
  message: string,
  actions: readonly T[],
  token: vscode.CancellationToken
): Promise<WarningMessageOutcome<T>> {
  if (token.isCancellationRequested) {
    return { kind: 'cancelled' };
  }

  return new Promise(resolve => {
    let settled = false;
    let cancellation: vscode.Disposable | undefined;
    const finish = (outcome: WarningMessageOutcome<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      cancellation?.dispose();
      resolve(outcome);
    };
    cancellation = token.onCancellationRequested(() => finish({ kind: 'cancelled' }));
    if (settled) {
      cancellation.dispose();
    }
    void vscode.window.showWarningMessage(message, ...actions).then(
      selected => finish({ kind: 'selection', selected }),
      error => finish({ kind: 'error', error })
    );
  });
}

async function fetchModelRecommendations(
  configuration: OllamaProviderConfiguration,
  request: typeof fetch,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel | undefined
): Promise<ModelRecommendation[]> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, recommendationTimeoutMS);
  try {
    const baseURL = configuration.url.endsWith('/') ? configuration.url : `${configuration.url}/`;
    const url = new URL('api/experimental/model-recommendations', baseURL);
    const headers = new Headers(configuration.headers);
    if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
    }
    const response = await request(url, { method: 'GET', headers, signal: controller.signal });
    const recommendations = parseModelRecommendations(await response.json());
    if (recommendations.length === 0) {
      output?.appendLine(`Ollama returned no model recommendations from ${url}.`);
      return [];
    }
    return recommendations;
  } catch (error) {
    if (isAbortError(error) && token.isCancellationRequested) {
      throw error;
    }
    const reason = timedOut
      ? `request timed out after ${recommendationTimeoutMS}ms`
      : formatError(error);
    output?.appendLine(`Model recommendations are unavailable; continuing without them: ${reason}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function getConfiguration(options?: vscode.PrepareLanguageModelChatModelOptions): OllamaProviderConfiguration {
  const configuration = (options as vscode.PrepareLanguageModelChatModelOptions & {
    configuration?: { readonly [key: string]: unknown };
  } | undefined)?.configuration;
  const settings = vscode.workspace.getConfiguration('ollama');
  const endpoint = settings.get<string>('endpoint', defaultOllamaURL) || defaultOllamaURL;

  return {
    url: typeof configuration?.url === 'string' && configuration.url.length > 0 ? configuration.url : endpoint,
    models: Array.isArray(configuration?.models)
      ? configuration.models.filter((model): model is string => typeof model === 'string' && model.length > 0)
      : [],
    headers: getConfiguredHeaders(configuration, settings)
  };
}

function selectConfiguredModels(
  configuredModels: readonly string[],
  availableModels: readonly OllamaTagsModel[]
): OllamaTagsModel[] {
  const byName = new Map(availableModels.map(model => [model.name, model]));
  return configuredModels.map(name => byName.get(name) ?? { name });
}

async function hydrateModels(
  ollama: Ollama,
  models: readonly OllamaTagsModel[]
): Promise<Array<{ model: OllamaTagsModel; show?: OllamaShowResponse }>> {
  return Promise.all(models.map(async model => ({
    model,
    show: shouldHydrateModel(model) ? await showModel(ollama, model.name) : undefined
  })));
}

function isOllamaTagsModel(model: unknown): model is OllamaTagsModel {
  return isRecord(model) && typeof model.name === 'string' && model.name.length > 0;
}

async function showModel(ollama: Ollama, model: string): Promise<OllamaShowResponse | undefined> {
  const request: ShowRequest & { verbose?: boolean } = { model, verbose: false };
  return ollama.show(request)
    .then(show => show as OllamaShowResponse)
    .catch(() => undefined);
}

function shouldHydrateModel(model: OllamaTagsModel): boolean {
  if (!isRemoteModel(model)) {
    return true;
  }
  return model.capabilities === undefined
    || (sharedContextWindow(model, undefined) === undefined
      && explicitTokenLimit(model, undefined, 'input') === undefined);
}

function isRemoteModel(model: OllamaTagsModel): boolean {
  return typeof model.remote_host === 'string' && model.remote_host.length > 0;
}

function getConfiguredHeaders(
  configuration: { readonly [key: string]: unknown } | undefined,
  settings: vscode.WorkspaceConfiguration
): Record<string, string> {
  const configured = isRecord(configuration?.headers)
    ? configuration.headers
    : settings.get<Record<string, unknown>>('headers', {});
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(configured)) {
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelFamily(model: OllamaTagsModel, show: OllamaShowResponse | undefined): string {
  const family = model.details?.family ?? show?.details?.family;
  return typeof family === 'string' && family.length > 0
    ? family
    : model.name.split(':')[0] || model.name;
}

function modelTokenLimits(model: OllamaTagsModel, show: OllamaShowResponse | undefined) {
  const explicitMaxInputTokens = explicitTokenLimit(model, show, 'input');
  const explicitMaxOutputTokens = explicitTokenLimit(model, show, 'output');
  const contextWindow = sharedContextWindow(model, show)
    ?? (explicitMaxInputTokens === undefined ? fallbackContextWindow : undefined);

  if (contextWindow === undefined) {
    return {
      maxInputTokens: explicitMaxInputTokens ?? fallbackContextWindow,
      maxOutputTokens: explicitMaxOutputTokens ?? defaultMaxOutputTokens
    };
  }

  // VS Code displays input + output; Ollama reports one shared context window.
  const maxOutputTokens = outputTokenLimit(contextWindow, explicitMaxOutputTokens);
  return {
    maxInputTokens: contextWindow - maxOutputTokens,
    maxOutputTokens
  };
}

function explicitTokenLimit(
  model: OllamaTagsModel,
  show: OllamaShowResponse | undefined,
  kind: 'input' | 'output'
): number | undefined {
  const keys = kind === 'input' ? ['max_input_tokens'] : ['max_output_tokens'];

  for (const value of [
    numericField(model, keys),
    numericField(show, keys),
    numericField(model.details, keys),
    numericField(show?.details, keys),
    numericModelInfoValue(model.model_info, keys),
    numericModelInfoValue(show?.model_info, keys)
  ]) {
    if (value !== undefined && value > 0) {
      return value;
    }
  }
  return undefined;
}

function sharedContextWindow(model: OllamaTagsModel, show: OllamaShowResponse | undefined): number | undefined {
  const keys = ['max_context_length', 'context_length'];

  for (const value of [
    numericParameterValue(show?.parameters, 'num_ctx'),
    numericParameterValue(show?.modelfile, 'num_ctx'),
    numericField(model, keys),
    numericField(show, keys),
    numericField(model.details, keys),
    numericField(show?.details, keys),
    numericModelInfoValue(model.model_info, keys),
    numericModelInfoValue(show?.model_info, keys)
  ]) {
    if (value !== undefined && value > 0) {
      return value;
    }
  }
  return undefined;
}

function outputTokenLimit(contextWindow: number, configuredOutputLimit: number | undefined): number {
  if (contextWindow <= 1) {
    return 0;
  }

  return Math.min(
    configuredOutputLimit ?? defaultMaxOutputTokens,
    contextWindow - 1
  );
}

function numericParameterValue(text: string | undefined, name: string): number | undefined {
  if (!text) {
    return undefined;
  }

  const pattern = new RegExp(`^\\s*(?:PARAMETER\\s+)?${escapeRegExp(name)}\\s+(-?\\d+)\\b`, 'im');
  const match = text.match(pattern);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function numericField(value: unknown, keys: readonly string[]): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'number') {
      return field;
    }
  }
  return undefined;
}

function numericModelInfoValue(modelInfo: ModelInfo | undefined, keys: readonly string[]): number | undefined {
  if (!modelInfo) {
    return undefined;
  }

  const entries = modelInfo instanceof Map ? modelInfo.entries() : Object.entries(modelInfo);
  for (const [key, value] of entries) {
    if (keys.some(expected => key.endsWith(`.${expected}`) || key === expected) && typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function hasCapability(capabilities: readonly string[], ...expected: string[]): boolean {
  const values = new Set(capabilities.map(capability => capability.toLowerCase()));
  return expected.some(capability => values.has(capability));
}

function mergedCapabilities(...sources: Array<readonly string[] | undefined>): string[] {
  const capabilities = new Set<string>();
  for (const source of sources) {
    for (const capability of source ?? []) {
      capabilities.add(capability);
    }
  }
  return [...capabilities];
}

function isAuthError(error: unknown): error is OllamaAPIError {
  return error instanceof OllamaAPIError && error.status === 401;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError';
}

function isCloudModel(model: string): boolean {
  const tag = model.split(':').at(-1)?.toLowerCase() ?? '';
  return tag === 'cloud' || tag.endsWith('-cloud');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function partToText(part: vscode.LanguageModelInputPart | unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('text/')) {
    return new TextDecoder().decode(part.data);
  }
  return '';
}

class CalibratedTokenEstimator {
  private readonly charsPerToken = new Map<string, number>();

  count(modelID: string, input: string | vscode.LanguageModelChatRequestMessage): number {
    const text = inputToText(input);
    if (text.length === 0) {
      return 0;
    }
    return Math.max(1, Math.ceil(text.length / (this.charsPerToken.get(modelID) ?? defaultCharsPerToken)));
  }

  record(modelID: string, messages: readonly vscode.LanguageModelChatRequestMessage[], actual: number) {
    const texts = messages.map(message => inputToText(message));
    const text = texts.join('\n');
    if (text.length === 0 || actual <= 0) {
      return;
    }

    const observedCharsPerToken = text.length / actual;
    const currentCharsPerToken = this.charsPerToken.get(modelID) ?? defaultCharsPerToken;
    this.charsPerToken.set(modelID, (currentCharsPerToken + observedCharsPerToken) / 2);
  }
}

function inputToText(input: string | vscode.LanguageModelChatRequestMessage): string {
  return typeof input === 'string' ? input : input.content.map(partToText).join('\n');
}

export function createFetch(token: vscode.CancellationToken, disposables: vscode.Disposable[]): typeof fetch {
  return async (input, init) => {
    const linkedSignal = abortSignal(token, init?.signal);
    disposables.push(linkedSignal);
    const response = await fetch(input, {
      ...init,
      signal: linkedSignal.signal
    });
    await throwIfNotOK(response, endpoint(input));
    return response;
  };
}

function abortSignal(token: vscode.CancellationToken, signal?: AbortSignal | null): vscode.Disposable & { signal: AbortSignal } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const disposable = token.onCancellationRequested(abort);
  let disposed = false;

  if (signal) {
    signal.addEventListener('abort', abort, { once: true });
  }
  if (token.isCancellationRequested || signal?.aborted) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      disposable.dispose();
      signal?.removeEventListener('abort', abort);
    }
  };
}

export function disposeAll(disposables: readonly vscode.Disposable[]) {
  for (const disposable of disposables) {
    disposable.dispose();
  }
}

async function throwIfNotOK(response: Response, endpoint: string) {
  if (response.ok) {
    return;
  }

  const body = await response.text().catch(() => '');
  const parsed = parseErrorBody(body);
  const detail = parsed?.error ?? body;
  throw new OllamaAPIError(
    `Ollama ${endpoint} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    response.status,
    endpoint,
    parsed?.error,
    parsed?.signin_url
  );
}

function parseErrorBody(body: string): OllamaErrorResponse | undefined {
  if (!body) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as OllamaErrorResponse;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function endpoint(input: RequestInfo | URL): string {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
