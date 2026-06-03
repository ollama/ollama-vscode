import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { toOllamaMessages, toOllamaTools } from './convert';
import { OllamaClient, OllamaShowResponse } from './ollamaClient';

interface OllamaProviderConfiguration {
  url: string;
  models: string[];
}

interface OllamaLanguageModel extends vscode.LanguageModelChatInformation {
  model: string;
  url: string;
}

const defaultOllamaURL = 'http://127.0.0.1:11434';
const defaultMaxInputTokens = 8192;
const defaultMaxOutputTokens = 4096;

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
    const client = new OllamaClient(configuration.url);
    const names = configuration.models.length > 0 ? configuration.models : await client.listModels(token);
    this.output?.appendLine(`Providing ${names.length} Ollama model(s) from ${configuration.url}.`);

    return Promise.all(names.map(async name => {
      const show = await client.show(name, token).catch(() => undefined);
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
        url: configuration.url
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
    const client = new OllamaClient(model.url);
    const tools = toOllamaTools(options.tools);
    this.output?.appendLine(`Sending chat request to ${model.model} at ${model.url}.`);

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
  }

  async provideTokenCount(
    _model: OllamaLanguageModel,
    input: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const text = typeof input === 'string' ? input : input.content.map(partToText).join('\n');
    return Math.ceil(text.length / 4);
  }
}

function getConfiguration(options: vscode.PrepareLanguageModelChatModelOptions): OllamaProviderConfiguration {
  const configuration = (options as vscode.PrepareLanguageModelChatModelOptions & {
    configuration?: { readonly [key: string]: unknown };
  }).configuration;

  return {
    url: typeof configuration?.url === 'string' && configuration.url.length > 0 ? configuration.url : defaultOllamaURL,
    models: Array.isArray(configuration?.models)
      ? configuration.models.filter((model): model is string => typeof model === 'string' && model.length > 0)
      : []
  };
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

function partToText(part: vscode.LanguageModelInputPart | unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('text/')) {
    return new TextDecoder().decode(part.data);
  }
  return '';
}
