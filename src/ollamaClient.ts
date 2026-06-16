import * as vscode from 'vscode';
import {
  Ollama,
  AbortableAsyncIterator,
  ChatRequest,
  ChatResponse,
  Message,
  ModelResponse,
  ShowResponse,
  Tool,
  ToolCall,
  VersionResponse
} from 'ollama';

export interface OllamaTagsModel {
  name: string;
  model?: string;
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

export type OllamaVersionResponse = VersionResponse;

export interface OllamaShowResponse extends Omit<ShowResponse, 'model_info'> {
  model_info?: ModelInfo;
  context_length?: number;
  max_context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

export type ModelInfo = Record<string, unknown> | Map<string, unknown>;

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

export interface OllamaToolCall extends ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaChatRequest extends Omit<ChatRequest, 'messages' | 'stream' | 'tools'> {
  messages: OllamaChatMessage[];
  stream: true;
  tools?: OllamaTool[];
}

export interface OllamaChatResponse extends Partial<Omit<ChatResponse, 'message'>> {
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

export class OllamaAPIError extends Error {
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

export class OllamaClient {
  constructor(
    private readonly baseURL: string,
    private readonly headers: Record<string, string> = {}
  ) {}

  async version(token: vscode.CancellationToken): Promise<OllamaVersionResponse> {
    const disposables: vscode.Disposable[] = [];
    try {
      return await this.client(token, disposables).version();
    } finally {
      disposeAll(disposables);
    }
  }

  async listModels(token: vscode.CancellationToken): Promise<OllamaTagsModel[]> {
    const disposables: vscode.Disposable[] = [];
    try {
      const body = await this.client(token, disposables).list();
      return (body.models ?? []).filter(model => typeof model.name === 'string' && model.name.length > 0) as unknown as OllamaTagsModel[];
    } finally {
      disposeAll(disposables);
    }
  }

  async showModel(model: string, token: vscode.CancellationToken): Promise<OllamaShowResponse> {
    const disposables: vscode.Disposable[] = [];
    try {
      return await this.client(token, disposables).show({ model }) as OllamaShowResponse;
    } finally {
      disposeAll(disposables);
    }
  }

  async *chat(request: OllamaChatRequest, token: vscode.CancellationToken): AsyncIterable<OllamaChatResponse> {
    const disposables: vscode.Disposable[] = [];
    let stream: AbortableAsyncIterator<ChatResponse> | undefined;
    let streamDisposable: vscode.Disposable | undefined;
    try {
      stream = await this.client(token, disposables).chat(request as ChatRequest & { stream: true });
      streamDisposable = token.onCancellationRequested(() => stream?.abort());
      for await (const chunk of stream) {
        yield chunk as OllamaChatResponse;
      }
    } finally {
      streamDisposable?.dispose();
      disposeAll(disposables);
    }
  }

  private client(token: vscode.CancellationToken, disposables: vscode.Disposable[]): Ollama {
    return new Ollama({
      host: this.baseURL,
      headers: this.headers,
      fetch: createFetch(token, disposables)
    });
  }
}

function createFetch(token: vscode.CancellationToken, disposables: vscode.Disposable[]): typeof fetch {
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

function disposeAll(disposables: readonly vscode.Disposable[]) {
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
