import * as vscode from 'vscode';
import { OllamaChatMessage, OllamaTool } from './provider';

export function toOllamaMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OllamaChatMessage[] {
  const converted: OllamaChatMessage[] = [];

  for (const message of messages) {
    const text: string[] = [];
    const images: string[] = [];
    const thinking: string[] = [];
    const toolCalls: NonNullable<OllamaChatMessage['tool_calls']> = [];
    const toolResults: OllamaChatMessage[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text.push(part.value);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (part.mimeType.startsWith('image/')) {
          images.push(Buffer.from(part.data).toString('base64'));
        } else if (part.mimeType.startsWith('text/')) {
          text.push(new TextDecoder().decode(part.data));
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          function: {
            name: part.name,
            arguments: part.input as Record<string, unknown>
          }
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        const result = toolResultContent(part);
        toolResults.push({
          role: 'tool',
          content: result.content,
          ...(result.images.length > 0 ? { images: result.images } : {}),
          tool_call_id: part.callId
        });
      } else if (part instanceof vscode.LanguageModelThinkingPart) {
        const parts = Array.isArray(part.value) ? part.value : [part.value];
        thinking.push(...parts);
      }
    }

    if (text.length > 0 || thinking.length > 0 || images.length > 0 || toolCalls.length > 0) {
      converted.push({
        role: roleToOllama(message.role),
        content: text.join('\n'),
        ...(thinking.length > 0 ? { thinking: thinking.join('\n') } : {}),
        images: images.length > 0 ? images : undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
      });
    }

    converted.push(...toolResults);
  }

  return converted;
}

export function toOllamaTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): OllamaTool[] {
  return (tools ?? []).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? {}
    }
  }));
}

function roleToOllama(role: vscode.LanguageModelChatMessageRole): string {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }

  const systemRole = (vscode.LanguageModelChatMessageRole as unknown as { System?: vscode.LanguageModelChatMessageRole }).System;
  if (systemRole !== undefined && role === systemRole) {
    return 'system';
  }

  return 'user';
}

function toolResultContent(part: vscode.LanguageModelToolResultPart): { content: string; images: string[] } {
  const content: string[] = [];
  const images: string[] = [];

  for (const item of part.content) {
    if (item instanceof vscode.LanguageModelTextPart) {
      content.push(item.value);
      continue;
    }
    if (item instanceof vscode.LanguageModelDataPart) {
      if (item.mimeType.startsWith('image/')) {
        images.push(Buffer.from(item.data).toString('base64'));
        continue;
      }
      if (item.mimeType.startsWith('text/')) {
        content.push(new TextDecoder().decode(item.data));
      } else if (isJsonMimeType(item.mimeType)) {
        content.push(new TextDecoder().decode(item.data));
      }
      continue;
    }
    content.push(JSON.stringify(item));
  }

  return { content: content.join('\n'), images };
}

function isJsonMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
  return normalized === 'application/json'
    || (normalized.startsWith('application/') && normalized.endsWith('+json'));
}
