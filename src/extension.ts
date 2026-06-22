import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import { OllamaLanguageModelProvider, createFetch, disposeAll } from './provider';

const defaultOllamaURL = 'http://127.0.0.1:11434';
const ollamaVendor = 'ollama';
const copilotByokOllamaEndpointSetting = 'github.copilot.chat.byok.ollamaEndpoint';
const copilotByokNoticeShownKey = 'ollama.copilotByokNoticeShown';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Ollama');
  const provider = new OllamaLanguageModelProvider(output);

  output.appendLine('Activated Ollama language model provider.');

  context.subscriptions.push(
    output,
    provider,
    vscode.lm.registerLanguageModelChatProvider(ollamaVendor, provider),
    vscode.commands.registerCommand('ollama.refreshModels', () => provider.refresh()),
    vscode.commands.registerCommand('ollama.diagnoseModels', () => diagnoseModels(output))
  );

  void showCopilotByokNotice(context, output);
}

export function deactivate() {}

async function showCopilotByokNotice(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  const copilotByokEndpoint = vscode.workspace.getConfiguration().get<string>(copilotByokOllamaEndpointSetting);
  if (!copilotByokEndpoint || context.globalState.get<boolean>(copilotByokNoticeShownKey)) {
    return;
  }

  output.appendLine(`Detected Copilot BYOK Ollama setting: ${copilotByokOllamaEndpointSetting}.`);
  await context.globalState.update(copilotByokNoticeShownKey, true);

  const openChatAction = 'Open Chat';
  const diagnoseAction = 'Diagnose Models';
  const message = 'Ollama is installed. To use the official extension, select an Ollama model from the Chat model picker instead of the Copilot BYOK Ollama provider.';
  const selected = await vscode.window.showInformationMessage(message, openChatAction, diagnoseAction);

  if (selected === openChatAction) {
    await vscode.commands.executeCommand('workbench.action.chat.open').then(undefined, error => {
      output.appendLine(`Could not open Chat: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else if (selected === diagnoseAction) {
    await diagnoseModels(output);
  }
}

async function diagnoseModels(output: vscode.OutputChannel) {
  output.show(true);
  output.appendLine('--- Diagnostics ---');

  const allVSCodeModels = await vscode.lm.selectChatModels();
  output.appendLine(`VS Code returned ${allVSCodeModels.length} total language model(s).`);
  for (const model of allVSCodeModels) {
    output.appendLine(`- ${model.vendor}/${model.id} (${model.name})`);
  }

  const ollamaVSCodeModels = allVSCodeModels.filter(model => model.vendor === ollamaVendor);
  output.appendLine(`VS Code returned ${ollamaVSCodeModels.length} Ollama language model(s).`);

  const directModels = await listDirectOllamaModels(output);
  if (directModels.length > 0) {
    output.appendLine(`Direct Ollama API returned ${directModels.length} model(s).`);
    for (const model of directModels.slice(0, 20)) {
      output.appendLine(`- ${model}`);
    }
    if (directModels.length > 20) {
      output.appendLine(`... ${directModels.length - 20} more`);
    }
  }

  output.appendLine('--- End Diagnostics ---');
}

async function listDirectOllamaModels(output: vscode.OutputChannel): Promise<string[]> {
  const settings = vscode.workspace.getConfiguration('ollama');
  const endpoint = settings.get<string>('endpoint', defaultOllamaURL) || defaultOllamaURL;
  const source = new vscode.CancellationTokenSource();
  const disposables: vscode.Disposable[] = [source];
  const ollama = new Ollama({
    host: endpoint,
    headers: getConfiguredHeaders(settings),
    fetch: createFetch(source.token, disposables)
  });
  const timer = setTimeout(() => source.cancel(), 5000);
  try {
    return ((await ollama.list()).models ?? [])
      .filter(model => typeof model.name === 'string' && model.name.length > 0)
      .map(model => model.name);
  } catch (error) {
    output.appendLine(`Direct Ollama API failed at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  } finally {
    clearTimeout(timer);
    disposeAll(disposables);
  }
}

function getConfiguredHeaders(settings: vscode.WorkspaceConfiguration): Record<string, string> {
  const configured = settings.get<Record<string, unknown>>('headers', {});
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(configured)) {
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}
