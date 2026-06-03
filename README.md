# Ollama VS Code Language Model Provider

This is a proof of concept for an Ollama VS Code extension that contributes
language models to VS Code/Copilot Chat.

It is intentionally separate from the VS Code repository. This POC declares
`vendor: "ollama-dev"` in `package.json`, registers a `LanguageModelChatProvider`,
discovers models from Ollama, and streams chat responses through Ollama's native
`/api/chat` endpoint.

## How it works

1. VS Code sees the `languageModelChatProviders` contribution in `package.json`.
2. VS Code activates the extension on `onLanguageModelChatProvider:ollama-dev`.
3. The extension calls `vscode.lm.registerLanguageModelChatProvider("ollama-dev", provider)`.
4. VS Code calls `provideLanguageModelChatInformation` to discover models.
5. When the user sends a chat request, VS Code calls `provideLanguageModelChatResponse`.
6. The provider converts VS Code messages/tools/images to Ollama `/api/chat`
   requests and streams `LanguageModelTextPart` / `LanguageModelToolCallPart`
   responses back to VS Code.

## Local configuration

VS Code can pass provider group configuration from `chatLanguageModels.json`:

```json
[
  {
    "vendor": "ollama-dev",
    "name": "Ollama",
    "url": "http://127.0.0.1:11434",
    "models": ["qwen3.5:cloud"]
  }
]
```

If `models` is omitted, the extension lists models from `/api/tags`.

## Development

```sh
npm install
npm run compile
```

Then open this folder in VS Code and use the Extension Development Host.

For a local smoke test:

1. Start Ollama.
2. Open `extensions/vscode` in VS Code.
3. Run the `Run Ollama VS Code Extension` debug configuration.
4. In the Extension Development Host window, run `Ollama: Test Prompt` from the
   command palette.
5. Inspect the `Ollama` output channel for model discovery and streaming output.

## Open questions for a production extension

- how to avoid `vendor: "ollama"` conflicts while VS Code still ships a built-in
  Ollama provider
- whether to publish as `ollama.ollama` or another Marketplace identifier
- exact token counting once Ollama exposes a suitable tokenizer/count endpoint
- richer handling for reasoning/thinking parts
- whether `ollama launch vscode` should install a VSIX, install from Marketplace,
  or only write the provider group configuration
