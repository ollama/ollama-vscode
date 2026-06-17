import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { toOllamaMessages, toOllamaTools } from './convert';
import {
  ChatRequest,
  ChatResponse,
  ModelInfo,
  OllamaAPIError,
  OllamaChatResponse,
  OllamaShowResponse,
  OllamaTagsModel,
  createOllama,
  disposeAll
} from './ollama';

interface OllamaProviderConfiguration {
  url: string;
  models: string[];
  headers: Record<string, string>;
}

interface OllamaLanguageModel extends vscode.LanguageModelChatInformation {
  model: string;
  url: string;
  headers: Record<string, string>;
}

const defaultOllamaURL = 'http://127.0.0.1:11434';
const fallbackMaxInputTokens = 4096;
const defaultCharsPerToken = 4;

export class OllamaLanguageModelProvider implements vscode.LanguageModelChatProvider<OllamaLanguageModel>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly tokenCounts = new CalibratedTokenEstimator();
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
    const ollama = createOllama(configuration.url, configuration.headers, token, disposables);
    const version = await ollama.version()
      .then(response => response.version)
      .catch(() => undefined);

    try {
      let models: OllamaTagsModel[];
      try {
        const body = await ollama.list();
        const availableModels = ((body.models ?? []) as unknown[]).filter(isOllamaTagsModel);
        models = configuration.models.length > 0
          ? selectConfiguredModels(configuration.models, availableModels)
          : availableModels;
      } catch (error) {
        throw this.userFacingError(error);
      }
      const hydratedModels = await hydrateModels(ollama, models, configuration.models);

      const versionSuffix = version ? ` with Ollama ${version}` : '';
      this.output?.appendLine(`Providing ${models.length} Ollama model(s) from ${configuration.url}${versionSuffix}.`);

      return hydratedModels.map(({ model, show }) => this.toLanguageModel(model, show, configuration));
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
    const disposables: vscode.Disposable[] = [];
    const ollama = createOllama(model.url, model.headers, token, disposables);
    const tools = toOllamaTools(options.tools);
    this.output?.appendLine(`Sending chat request to ${model.model} at ${model.url}.`);

    try {
      let promptTokenCount: number | undefined;
      const stream = await ollama.chat({
        model: model.model,
        messages: toOllamaMessages(messages),
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
    } catch (error) {
      throw await this.handleChatError(model, error);
    } finally {
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

  private toLanguageModel(
    model: OllamaTagsModel,
    show: OllamaShowResponse | undefined,
    configuration: OllamaProviderConfiguration
  ): OllamaLanguageModel {
    const capabilities = model.capabilities ?? show?.capabilities ?? [];
    const name = model.name;
    const maxInputTokens = tokenLimit(model, show, 'input') ?? fallbackMaxInputTokens;

    return {
      id: name,
      name,
      family: modelFamily(model, show),
      tooltip: name,
      version: '1.0',
      maxInputTokens,
      maxOutputTokens: tokenLimit(model, show, 'output') ?? maxInputTokens,
      capabilities: {
        toolCalling: hasCapability(capabilities, 'tools', 'tool'),
        imageInput: hasCapability(capabilities, 'vision', 'image')
      },
      model: name,
      url: configuration.url,
      headers: configuration.headers
    };
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
  ollama: ReturnType<typeof createOllama>,
  models: readonly OllamaTagsModel[],
  configuredModels: readonly string[]
): Promise<Array<{ model: OllamaTagsModel; show?: OllamaShowResponse }>> {
  const configured = new Set(configuredModels);
  const hydrated: Array<{ model: OllamaTagsModel; show?: OllamaShowResponse }> = [];
  for (const model of models) {
    hydrated.push({
      model,
      show: configured.has(model.name) && isFallbackModel(model)
        ? await ollama.show({ model: model.name }).then(show => show as OllamaShowResponse).catch(() => undefined)
        : undefined
    });
  }
  return hydrated;
}

function isOllamaTagsModel(model: unknown): model is OllamaTagsModel {
  return isRecord(model) && typeof model.name === 'string' && model.name.length > 0;
}

function isFallbackModel(model: OllamaTagsModel): boolean {
  return model.details === undefined && model.capabilities === undefined;
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

function tokenLimit(
  model: OllamaTagsModel,
  show: OllamaShowResponse | undefined,
  kind: 'input' | 'output'
): number | undefined {
  const keys = kind === 'input'
    ? ['max_input_tokens', 'max_context_length', 'context_length']
    : ['max_output_tokens'];

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

function isAuthError(error: unknown): error is OllamaAPIError {
  return error instanceof OllamaAPIError && error.status === 401;
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
