import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import { OllamaLanguageModelProvider, createFetch, disposeAll } from './provider';
import { inspectOllamaModels, ollamaDiagnosticsClientOptions } from './diagnostics';

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

  const allVSCodeModels = await vscode.lm.selectChatModels();
  output.appendLine(`VS Code returned ${allVSCodeModels.length} total language model(s).`);
  for (const model of allVSCodeModels) {
    output.appendLine(`- ${model.vendor}/${model.id} (${model.name})`);
  }

  const ollamaVSCodeModels = allVSCodeModels.filter(model => model.vendor === ollamaVendor);
  output.appendLine(`VS Code returned ${ollamaVSCodeModels.length} Ollama language model(s).`);

  await inspectDirectOllamaModels(output);

  output.appendLine('--- End Diagnostics ---');
}

async function inspectDirectOllamaModels(output: vscode.OutputChannel): Promise<void> {
  const settings = vscode.workspace.getConfiguration('ollama');
  const endpoint = settings.get<string>('endpoint', defaultOllamaURL) || defaultOllamaURL;
  const source = new vscode.CancellationTokenSource();
  const disposables: vscode.Disposable[] = [source];
  const ollama = new Ollama(ollamaDiagnosticsClientOptions(
    endpoint,
    settings.get<Record<string, unknown>>('headers', {}),
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
