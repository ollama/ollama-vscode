import * as vscode from 'vscode';
import { OllamaChatMessage, OllamaTool } from './ollamaClient';

export function toOllamaMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OllamaChatMessage[] {
  const converted: OllamaChatMessage[] = [];

  for (const message of messages) {
    const text: string[] = [];
    const images: string[] = [];
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
        toolResults.push({
          role: 'tool',
          content: toolResultContent(part),
          tool_call_id: part.callId
        });
      }
    }

    if (text.length > 0 || images.length > 0 || toolCalls.length > 0) {
      converted.push({
        role: roleToOllama(message.role),
        content: text.join('\n'),
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

function toolResultContent(part: vscode.LanguageModelToolResultPart): string {
  return part.content.map(item => {
    if (item instanceof vscode.LanguageModelTextPart) {
      return item.value;
    }
    if (item instanceof vscode.LanguageModelDataPart && item.mimeType.startsWith('text/')) {
      return new TextDecoder().decode(item.data);
    }
    return JSON.stringify(item);
  }).join('\n');
}
