# Ollama for VS Code

This extension contributes Ollama models to VS Code/Copilot Chat as a language
model provider.

It discovers models from a running Ollama server and streams chat responses
through Ollama's native `/api/chat` endpoint.

## How it works

1. VS Code sees the `languageModelChatProviders` contribution in `package.json`.
2. VS Code activates the extension on `onLanguageModelChatProvider:ollama`.
3. The extension calls `vscode.lm.registerLanguageModelChatProvider("ollama", provider)`.
4. VS Code calls `provideLanguageModelChatInformation` to discover models.
5. When the user sends a chat request, VS Code calls `provideLanguageModelChatResponse`.
6. The provider converts VS Code messages/tools/images to Ollama `/api/chat`
   requests and streams `LanguageModelTextPart` / `LanguageModelToolCallPart`
   responses back to VS Code.

## Installation

There are two supported installation paths.

### Install from the Marketplace

After this extension is published, install it from the VS Code Marketplace by
searching for `Ollama` in the Extensions view.

### Install manually from a VSIX

For local testing or manual installation before Marketplace publishing, install
a packaged VSIX from the command line:

```sh
code --install-extension ollama-vscode-0.0.1.vsix
```

You can also install a VSIX from VS Code by running `Extensions: Install from
VSIX...` from the Command Palette.

VSIX installs are useful for development and testing, but Marketplace installs
are the preferred path for general users because VS Code can discover and update
Marketplace extensions normally.

## Usage

1. Install and start Ollama.
2. Install this extension.
3. Open Copilot Chat in VS Code.
4. Open the model picker.
5. Select a model from the `Ollama` provider section.

Local models work without signing in to Ollama. Cloud models and cloud-only
features may require signing in through Ollama first. If a cloud request needs
sign-in, the extension shows a sign-in prompt and opens the sign-in URL provided
by the local Ollama server when available.

## Configuration

By default, the extension connects to:

```txt
http://127.0.0.1:11434
```

You can configure the endpoint and optional request headers with VS Code
settings:

```json
{
  "ollama.endpoint": "http://127.0.0.1:11434",
  "ollama.headers": {}
}
```

The extension checks `/api/version` before model discovery and requires Ollama
0.6.4 or newer. It lists models from `/api/tags` and reads model details from
`/api/show`.

VS Code can also pass provider group configuration through
`chatLanguageModels.json`:

```json
[
  {
    "vendor": "ollama",
    "name": "Ollama",
    "url": "http://127.0.0.1:11434",
    "models": ["qwen3.5:cloud"],
    "headers": {}
  }
]
```

If `models` is omitted, the extension lists all models from `/api/tags`.
Provider group configuration takes precedence when VS Code supplies it.

## Development

```sh
npm install
npm run compile
```

Then open this folder in VS Code and use the Extension Development Host.

For a local smoke test:

1. Start Ollama.
2. Open this repository in VS Code.
3. Run the `Run Ollama VS Code Extension` debug configuration.
4. In the Extension Development Host window, run `Ollama: Test Prompt` from the
   command palette.
5. Inspect the `Ollama` output channel for model discovery and streaming output.

To package a local VSIX:

```sh
npm install
npm run compile
npx @vscode/vsce package --out ollama-vscode-0.0.1.vsix
```
