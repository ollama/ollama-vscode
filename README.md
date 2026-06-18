# Ollama for VS Code

Use Ollama models in VS Code Chat.

The Ollama extension adds models from your running Ollama server to the VS Code
model picker.

## Requirements

- Visual Studio Code 1.120 or newer.
- Ollama installed and running.
- At least one local or cloud model available in Ollama.

Ollama 0.17.6 or newer is recommended for cloud model sign-in and richer model
metadata. Older Ollama versions may still work for local models.

Pull a local model:

```sh
ollama pull qwen3.6
```

Pull a cloud model:

```sh
ollama pull kimi-k2.6:cloud
```

Local models do not require sign-in. To use cloud models, run:

```sh
ollama signin
```

## Get started

1. Install the Ollama extension from the VS Code Marketplace.
2. Start Ollama.
3. Open Chat in VS Code.
4. Open the model picker at the bottom of the chat input.
5. Choose a model from the `Ollama` section.

The extension discovers models from the Ollama server at
`http://127.0.0.1:11434` by default.

## Commands

The extension adds these commands to the Command Palette:

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

Configure the endpoint and optional request headers in VS Code settings:

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

If `models` is omitted, the extension lists every model returned by `/api/tags`.
Provider configuration from VS Code takes precedence over workspace settings.

## Troubleshooting

If Ollama models do not appear:

1. Make sure Ollama is running.
2. Run `ollama list` and confirm models are available.
3. Run `Ollama: Refresh Models` from the Command Palette.
4. Run `Ollama: Diagnose Models` and check the `Ollama` output channel.

If a cloud model asks you to sign in, run:

```sh
ollama signin
```

## Development

Install dependencies and compile:

```sh
npm install
npm run compile
```

Then open this folder in VS Code and run the Extension Development Host.

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
