# Ollama for VS Code

Use Ollama models in VS Code Chat.

The Ollama extension adds models from your running Ollama server to the VS Code
model picker.

## Requirements

- Visual Studio Code 1.120 or newer.
- Ollama installed and running.
- At least one local or cloud model available in Ollama.

Ollama 0.17.6 or newer is recommended for cloud model sign-in and richer model metadata. Older Ollama versions may still work for local models.

```sh
# Pull a local model
ollama pull qwen3.6

# Pull a cloud model
ollama pull kimi-k2.6:cloud

# Sign in for cloud models
ollama signin
```

Local models do not require sign-in. Run `ollama signin` to use cloud models.

## Get started

1. Install the Ollama extension from the VS Code Marketplace.
2. Start Ollama.
3. Open Chat in VS Code.
4. Open the model picker at the bottom of the chat input.
5. Choose a model from the `Ollama` section.

The extension discovers models from `http://127.0.0.1:11434` by default.

## Commands

The extension adds these commands to the Command Palette:

- `Ollama: Refresh Models`: reload the list of Ollama models shown in VS Code.
- `Ollama: Diagnose Models`: print model discovery information to the Ollama
  output channel for troubleshooting.

Use `Diagnose Models` if models are available in Ollama but do not appear in the VS Code model picker.

## Troubleshooting

If you previously configured Ollama through Copilot BYOK, choose an Ollama
model from the Chat model picker after installing this extension. Installing the
extension adds the official Ollama provider, but it does not automatically
switch existing chats away from Copilot BYOK.

If Ollama models do not appear:

1. Make sure Ollama is running.
2. Run `ollama list` and confirm models are available.
3. Run `Ollama: Refresh Models` from the Command Palette.
4. Run `Ollama: Diagnose Models` and check the `Ollama` output channel.

If a cloud model asks you to sign in, run `ollama signin`.
