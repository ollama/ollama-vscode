import * as vscode from 'vscode';

export interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

export interface OllamaChatMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

export interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: true;
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
}

export interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
}

export class OllamaClient {
  constructor(private readonly baseURL: string) {}

  async listModels(token: vscode.CancellationToken): Promise<string[]> {
    const response = await fetch(this.url('/api/tags'), {
      signal: abortSignal(token)
    });
    await throwIfNotOK(response, '/api/tags');

    const body = await response.json() as { models?: Array<{ name: string }> };
    return (body.models ?? []).map(model => model.name);
  }

  async show(model: string, token: vscode.CancellationToken): Promise<OllamaShowResponse> {
    const response = await fetch(this.url('/api/show'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: abortSignal(token)
    });
    await throwIfNotOK(response, '/api/show');

    return response.json() as Promise<OllamaShowResponse>;
  }

  async *chat(request: OllamaChatRequest, token: vscode.CancellationToken): AsyncIterable<OllamaChatResponse> {
    const response = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: abortSignal(token)
    });
    await throwIfNotOK(response, '/api/chat');

    if (!response.body) {
      throw new Error('Ollama /api/chat did not return a response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) {
          break;
        }

        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          yield JSON.parse(line) as OllamaChatResponse;
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      yield JSON.parse(tail) as OllamaChatResponse;
    }
  }

  private url(path: string): string {
    return `${this.baseURL.replace(/\/+$/, '')}${path}`;
  }
}

function abortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

async function throwIfNotOK(response: Response, endpoint: string) {
  if (response.ok) {
    return;
  }

  const body = await response.text().catch(() => '');
  throw new Error(`Ollama ${endpoint} failed with HTTP ${response.status}${body ? `: ${body}` : ''}`);
}
