import * as vscode from 'vscode';
import { types } from 'node:util';
import { OllamaChatMessage, OllamaTool } from './provider';

export function toOllamaMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OllamaChatMessage[] {
  const converted: OllamaChatMessage[] = [];

  for (const message of messages) {
    const text: string[] = [];
    const images: string[] = [];
    const toolCalls: NonNullable<OllamaChatMessage['tool_calls']> = [];
    const toolResults: OllamaChatMessage[] = [];

    for (const part of message.content) {
      if (isTextPart(part)) {
        text.push(part.value);
      } else if (isDataPart(part)) {
        if (part.mimeType.startsWith('image/')) {
          images.push(Buffer.from(part.data).toString('base64'));
        } else if (part.mimeType.startsWith('text/')) {
          text.push(new TextDecoder().decode(part.data));
        }
      } else if (isToolCallPart(part)) {
        toolCalls.push({
          id: part.callId,
          function: {
            name: part.name,
            arguments: part.input as Record<string, unknown>
          }
        });
      } else if (isToolResultPart(part)) {
        const result = toolResultContent(part);
        toolResults.push({
          role: 'tool',
          content: result.content,
          ...(result.images.length > 0 ? { images: result.images } : {}),
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
      parameters: toolInputSchema(tool.inputSchema)
    }
  }));
}

function toolInputSchema(schema: object | undefined): object {
  if (schema === undefined || schema === null || (
    typeof schema === 'object' && !Array.isArray(schema) && Object.keys(schema).length === 0
  )) {
    // Ollama reserializes {} as { type: '', properties: null }, which its
    // template parser rejects. Describe parameterless tools as objects.
    return { type: 'object', properties: {} };
  }
  return schema;
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
    if (isTextPart(item)) {
      content.push(item.value);
      continue;
    }
    if (isDataPart(item)) {
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

export function isTextPart(part: unknown): part is vscode.LanguageModelTextPart {
  return part instanceof vscode.LanguageModelTextPart || (
    typeof part === 'object' &&
    part !== null &&
    'value' in part &&
    typeof (part as { value: unknown }).value === 'string' &&
    !('callId' in part) &&
    !('mimeType' in part) &&
    // Thinking parts also have a value; serialized VS Code parts need revival.
    !('id' in part) &&
    !('metadata' in part) &&
    !('$mid' in part) &&
    // Preserve arbitrary JSON tool results with a value and additional fields.
    Object.keys(part).every(key => key === 'value' || key === 'audience')
  );
}

export function isDataPart(part: unknown): part is vscode.LanguageModelDataPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    'mimeType' in part &&
    typeof (part as { mimeType: unknown }).mimeType === 'string' &&
    'data' in part &&
    types.isUint8Array((part as { data: unknown }).data)
  );
}

export function isToolCallPart(part: unknown): part is vscode.LanguageModelToolCallPart {
  return part instanceof vscode.LanguageModelToolCallPart || (
    typeof part === 'object' &&
    part !== null &&
    'callId' in part &&
    typeof (part as { callId: unknown }).callId === 'string' &&
    'name' in part &&
    typeof (part as { name: unknown }).name === 'string' &&
    !('content' in part)
  );
}

export function isToolResultPart(part: unknown): part is vscode.LanguageModelToolResultPart {
  return part instanceof vscode.LanguageModelToolResultPart || (
    typeof part === 'object' &&
    part !== null &&
    'callId' in part &&
    typeof (part as { callId: unknown }).callId === 'string' &&
    'content' in part &&
    Array.isArray((part as { content: unknown }).content)
  );
}
