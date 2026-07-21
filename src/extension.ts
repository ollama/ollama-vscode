import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import { OllamaLanguageModelProvider, createFetch, disposeAll } from './provider';

const defaultOllamaURL = 'http://127.0.0.1:11434';
const ollamaVendor = 'ollama-models';

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
}

export function deactivate() {}

async function diagnoseModels(output: vscode.OutputChannel) {
  output.show(true);
  output.appendLine('--- Diagnostics ---');

  const settings = vscode.workspace.getConfiguration('ollama');
  const endpoint = settings.get<string>('endpoint', defaultOllamaURL) || defaultOllamaURL;
  const useOpenWebUIProxy = settings.get<boolean>('useOpenWebUIProxy', false);
  const openWebUIApiKey = settings.get<string>('openWebUIApiKey', '');

  output.appendLine(`Ollama endpoint: ${endpoint}`);

  // Report Open WebUI proxy status
  if (useOpenWebUIProxy) {
    const maskedKey = openWebUIApiKey
      ? openWebUIApiKey.slice(0, 4) + '***'
      : '(not set — proxy may fail without an API key)';
    output.appendLine(`Open WebUI Proxy: enabled (key: ${maskedKey})`);
  } else {
    output.appendLine(`Open WebUI Proxy: disabled (direct Ollama)`);
  }

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
  let endpoint = settings.get<string>('endpoint', defaultOllamaURL) || defaultOllamaURL;
  const useOpenWebUIProxy = settings.get<boolean>('useOpenWebUIProxy', false);
  const openWebUIApiKey = settings.get<string>('openWebUIApiKey', '');

  // If Open WebUI proxy is enabled, prepend /ollama to the base URL
  if (useOpenWebUIProxy) {
    endpoint = endpoint.replace(/\/+$/, '') + '/ollama';
  }

  const source = new vscode.CancellationTokenSource();
  const disposables: vscode.Disposable[] = [source];
  const headers = getConfiguredHeaders(settings);

  // If Open WebUI proxy is enabled, inject the Bearer auth header
  if (useOpenWebUIProxy && openWebUIApiKey) {
    headers['Authorization'] = `Bearer ${openWebUIApiKey}`;
    headers['Content-Type'] = 'application/json';
  }

  const ollama = new Ollama({
    host: endpoint,
    headers,
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
