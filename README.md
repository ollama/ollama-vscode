# Ollama for VS Code

Use Ollama models in Visual Studio Code Chat.

The Ollama extension adds models from your running Ollama server to the VS Code
model picker, so you can use local and cloud Ollama models directly in the
editor.

## Why use it

- Use local models in VS Code without sending prompts to a hosted model provider.
- Use Ollama cloud models from the same model picker when you want larger hosted
  models or longer context windows.
- Keep using the VS Code Chat experience while choosing the Ollama model that
  fits the task.

## Requirements

- Visual Studio Code 1.120 or newer.
- Ollama installed and running.
- At least one Ollama model available locally or from Ollama cloud.

To pull a local model:

```sh
ollama pull qwen3.6
```

To use a cloud model:

```sh
ollama pull kimi-k2.6:cloud
```

Local models work without signing in to Ollama. Cloud models and cloud-only
features may ask you to sign in when needed.

## Get started

1. Install the Ollama extension from the VS Code Marketplace.
2. Start Ollama.
3. Open Chat in VS Code from the Chat icon in the Activity Bar or with `Chat: Open Chat` from the Command Palette.
4. In the Chat view, open the model dropdown at the bottom of the chat input.
5. Choose a model from the `Ollama` section.

The extension discovers models from the Ollama server at
`http://127.0.0.1:11434` by default.

## Commands

The extension contributes these commands to the Command Palette:

- `Ollama: Refresh Models`: reload the list of Ollama models shown in VS Code.
- `Ollama: Diagnose Models`: print model discovery information to the Ollama
  output channel for troubleshooting.

Use `Diagnose Models` if models are available in Ollama but do not appear in the
VS Code model picker.

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

VS Code can also pass provider configuration through `chatLanguageModels.json`:

```json
[
  {
    "vendor": "ollama-vscode",
    "name": "Ollama",
    "url": "http://127.0.0.1:11434",
    "models": ["qwen3.6"],
    "headers": {}
  }
]
```

If `models` is omitted, the extension lists all models returned by `/api/tags`.
Provider configuration from VS Code takes precedence over workspace settings.

## How it works

The extension contributes an Ollama language model provider to VS Code. It lists
models from Ollama's `/api/tags` endpoint, reads model metadata from
`/api/show`, and streams chat responses through `/api/chat`.

When a chat request is sent, the extension converts VS Code chat messages,
tools, and images into Ollama chat requests, then streams text and tool calls
back to VS Code.

## Troubleshooting

If Ollama models do not appear in VS Code:

1. Make sure Ollama is running.
2. Run `ollama list` in a terminal and confirm models are available.
3. Run `Ollama: Refresh Models` from the Command Palette.
4. Run `Ollama: Diagnose Models` and check the `Ollama` output channel.

If a cloud model asks you to sign in, follow the sign-in prompt shown by VS Code.

## Development

Install dependencies and compile:

```sh
npm install
npm run compile
```

Then open this folder in VS Code and use the Extension Development Host.

To package a local VSIX:

```sh
npm install
npm run compile
npx @vscode/vsce package --out ollama-vscode-0.0.1.vsix
```

For local testing, install the packaged VSIX:

```sh
code --install-extension ollama-vscode-0.0.1.vsix
```

You can also install a VSIX from VS Code by running `Extensions: Install from
VSIX...` from the Command Palette.
