import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import { OllamaLanguageModelProvider, createFetch, disposeAll } from './provider';
import {
  inspectOllamaModels,
  ollamaDiagnosticsClientOptions,
  type OllamaDiagnosticsConfigurationSource
} from './diagnostics';

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
    vscode.commands.registerCommand('ollama.diagnoseModels', () => diagnoseModels(output, provider))
  );
}

export function deactivate() {}

async function diagnoseModels(output: vscode.OutputChannel, provider: OllamaLanguageModelProvider) {
  output.show(true);
  output.appendLine('--- Diagnostics ---');

  // Open WebUI proxy status reporting
  const settings = vscode.workspace.getConfiguration('ollama');
  const endpoint = settings.get<string>('endpoint', defaultOllamaURL) || defaultOllamaURL;
  const useOpenWebUIProxy = settings.get<boolean>('useOpenWebUIProxy', false);
  const openWebUIApiKey = settings.get<string>('openWebUIApiKey', '');
  output.appendLine(`Ollama endpoint: ${endpoint}`);
  if (useOpenWebUIProxy) {
    const maskedKey = openWebUIApiKey ? openWebUIApiKey.slice(0, 4) + '***' : '(not set — proxy may fail without an API key)';
    output.appendLine(`Open WebUI Proxy: enabled (key: ${maskedKey})`);
  } else {
    output.appendLine('Open WebUI Proxy: disabled (direct Ollama)');
  }

  const allVSCodeModels = await vscode.lm.selectChatModels();
  output.appendLine(`VS Code returned ${allVSCodeModels.length} total language model(s).`);
  for (const model of allVSCodeModels) {
    output.appendLine(`- ${model.vendor}/${model.id} (${model.name})`);
  }

  const ollamaVSCodeModels = allVSCodeModels.filter(model => model.vendor === ollamaVendor);
  output.appendLine(`VS Code returned ${ollamaVSCodeModels.length} Ollama language model(s).`);

  await inspectDirectOllamaModels(output, provider);

  output.appendLine('--- End Diagnostics ---');
}

async function inspectDirectOllamaModels(
  output: vscode.OutputChannel,
  provider: OllamaLanguageModelProvider
): Promise<void> {
  const settings = vscode.workspace.getConfiguration('ollama');
  const workspaceEndpoint = settings.get<string>('endpoint', defaultOllamaURL) || defaultOllamaURL;

  // Open WebUI proxy support — read settings for proxy toggle and key
  const useOpenWebUIProxy = settings.get<boolean>('useOpenWebUIProxy', false);
  const openWebUIApiKey = settings.get<string>('openWebUIApiKey', '');

  const selected = provider.selectDiagnosticsConfiguration({
    url: workspaceEndpoint,
    headers: getConfiguredHeaders(settings)
  });

  // Use 'let' so we can rewrite endpoint if proxy is enabled
  let endpoint = selected.configuration.url;
  let headers = { ...selected.configuration.headers };

  output.appendLine(
    `Direct Ollama API is inspecting ${configurationSourceLabel(selected.source)} at ${endpoint}.`
  );

  // Open WebUI: rewrite URL to prepend /ollama prefix
  if (useOpenWebUIProxy) {
    endpoint = endpoint.replace(/\/+$/, '') + '/ollama';
  }

  // Open WebUI: inject Bearer auth headers when proxy is enabled
  if (useOpenWebUIProxy && openWebUIApiKey) {
    headers['Authorization'] = `Bearer ${openWebUIApiKey}`;
    headers['Content-Type'] = 'application/json';
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
  const ollama = new Ollama(ollamaDiagnosticsClientOptions(
    endpoint,
    headers,
    createFetch(source.token, disposables)
  ));
  const timer = setTimeout(() => source.cancel(), 5000);
  try {
    const inspection = await inspectOllamaModels(ollama);

    if (inspection.availableModels !== undefined) {
      const availableModelNames = inspection.availableModels;
      if (availableModelNames.length > 0) {
        output.appendLine(`Direct Ollama API returned ${availableModelNames.length} model(s).`);
        for (const model of availableModelNames.slice(0, 20)) {
          output.appendLine(`- ${model}`);
        }
        if (availableModelNames.length > 20) {
          output.appendLine(`... ${availableModelNames.length - 20} more`);
        }
      }
    } else {
      output.appendLine(`Direct Ollama API failed at ${endpoint}: ${formatError(inspection.availableModelsError)}`);
    }

    if (inspection.loadedModelLines !== undefined) {
      for (const line of inspection.loadedModelLines) {
        output.appendLine(line);
      }
    } else {
      output.appendLine(`Could not inspect loaded Ollama models at ${endpoint}: ${formatError(inspection.loadedModelsError)}`);
    }
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

function configurationSourceLabel(source: OllamaDiagnosticsConfigurationSource): string {
  switch (source) {
    case 'used-provider-group':
      return 'the most recently used provider group';
    case 'resolved-provider-group':
      return 'the most recently resolved provider group';
    case 'workspace-settings':
      return 'workspace settings';
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
