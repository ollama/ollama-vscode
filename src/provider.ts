import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { toOllamaMessages, toOllamaTools } from './convert';
import { OllamaAPIError, OllamaClient, OllamaShowResponse } from './ollamaClient';

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
const defaultMaxInputTokens = 8192;
const defaultMaxOutputTokens = 4096;
const minimumOllamaVersion = '0.6.4';

export class OllamaLanguageModelProvider implements vscode.LanguageModelChatProvider<OllamaLanguageModel>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
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
    const client = new OllamaClient(configuration.url, configuration.headers);
    let version: string;
    try {
      ({ version } = await client.version(token));
    } catch (error) {
      throw this.userFacingError(error);
    }
    if (!isVersionSupported(version, minimumOllamaVersion)) {
      throw new Error(`Ollama ${version} is not supported. Please upgrade to ${minimumOllamaVersion} or newer.`);
    }

    let names: string[];
    try {
      names = configuration.models.length > 0 ? configuration.models : await client.listModels(token);
    } catch (error) {
      throw this.userFacingError(error);
    }
    this.output?.appendLine(`Providing ${names.length} Ollama model(s) from ${configuration.url} with Ollama ${version}.`);

    return Promise.all(names.map(async name => {
      const show = await client.show(name, token).catch(error => {
        this.output?.appendLine(`Could not read model details for ${name}: ${formatError(error)}`);
        return undefined;
      });
      const capabilities = show?.capabilities ?? [];

      return {
        id: name,
        name,
        family: modelFamily(name),
        version: '1.0',
        maxInputTokens: contextLength(show) ?? defaultMaxInputTokens,
        maxOutputTokens: defaultMaxOutputTokens,
        capabilities: {
          toolCalling: capabilities.includes('tools'),
          imageInput: capabilities.includes('vision')
        },
        model: name,
        url: configuration.url,
        headers: configuration.headers
      };
    }));
  }

  async provideLanguageModelChatResponse(
    model: OllamaLanguageModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const client = new OllamaClient(model.url, model.headers);
    const tools = toOllamaTools(options.tools);
    this.output?.appendLine(`Sending chat request to ${model.model} at ${model.url}.`);

    try {
      for await (const chunk of client.chat({
        model: model.model,
        messages: toOllamaMessages(messages),
        stream: true,
        tools: tools.length > 0 ? tools : undefined,
        options: options.modelOptions ? { ...options.modelOptions } : undefined
      }, token)) {
        const content = chunk.message?.content;
        if (content) {
          progress.report(new vscode.LanguageModelTextPart(content));
        }

        for (const toolCall of chunk.message?.tool_calls ?? []) {
          progress.report(new vscode.LanguageModelToolCallPart(
            toolCall.id ?? randomUUID(),
            toolCall.function.name,
            toolCall.function.arguments
          ));
        }
      }
    } catch (error) {
      throw await this.handleChatError(model, error);
    }
  }

  async provideTokenCount(
    _model: OllamaLanguageModel,
    input: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const text = typeof input === 'string' ? input : input.content.map(partToText).join('\n');
    return Math.ceil(text.length / 4);
  }

  private async handleChatError(model: OllamaLanguageModel, error: unknown): Promise<Error> {
    this.output?.appendLine(`Ollama request failed for ${model.model}: ${formatError(error)}`);

    if (isAuthError(error)) {
      const message = isCloudModel(model.model)
        ? `Sign in to Ollama to use ${model.model}.`
        : 'Sign in to Ollama and try again.';

      if (error.signinURL) {
        const action = 'Sign In';
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
      return new Error('Sign in to Ollama and try again.');
    }
    return error instanceof Error ? error : new Error(String(error));
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

function modelFamily(model: string): string {
  return model.split(':')[0] || model;
}

function contextLength(show: OllamaShowResponse | undefined): number | undefined {
  for (const [key, value] of Object.entries(show?.model_info ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function isVersionSupported(version: string, minimum: string): boolean {
  if (version === '0.0.0') {
    return true;
  }

  const currentParts = parseVersion(version);
  const minimumParts = parseVersion(minimum);
  const length = Math.max(currentParts.length, minimumParts.length);
  for (let i = 0; i < length; i++) {
    const current = currentParts[i] ?? 0;
    const required = minimumParts[i] ?? 0;
    if (current > required) {
      return true;
    }
    if (current < required) {
      return false;
    }
  }
  return true;
}

function parseVersion(version: string): number[] {
  return version.split('.').map(part => Number.parseInt(part, 10) || 0);
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
