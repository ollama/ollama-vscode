# Ollama for VS Code

Use Ollama models in VS Code Chat.

The Ollama extension adds models from your running Ollama server to the VS Code
model picker.

## Requirements

- Visual Studio Code 1.127 or newer. Earlier versions do not reliably cancel
  requests from language model providers.
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

## Thinking effort

Configure thinking effort for compatible Ollama models. Each model uses its own
supported values; models that advertise thinking values through `/api/show`
do not need a model-specific mapping in the extension.

1. Run `ollama list` to find the exact model name, including its tag.
2. Open the Command Palette and choose **Preferences: Open User Settings (JSON)**.
3. Add `ollama.thinkingLevels` to your existing settings object. Replace the
   placeholders with your model's name and a thinking value it supports:

   ```json
   {
     "ollama.thinkingLevels": {
       "<model-name:tag>": "<supported-level>"
     }
   }
   ```

4. Save the settings, select the matching Ollama model in Chat, and send a new
   message. Changes apply to the next request; no restart is needed.

Add an entry for each model you want to configure. Some models accept booleans
(`true` or `false`); others accept named levels such as `"low"` or `"high"`.
Use only values supported by the selected model, and do not quote booleans.
The extension uses the values advertised by the server's `/api/show` response,
with known-model fallbacks for older servers. Remove a model's entry to use the
server default. Unsupported values are ignored.

This setting controls the model's thinking effort. Native thinking display and
the effort dropdown beside the Chat model picker are separate follow-ups. The
dropdown depends on a VS Code proposed API; using a normal setting keeps this
change compatible with stable extension APIs and avoids the
[Marketplace restriction on proposed APIs](https://code.visualstudio.com/api/advanced-topics/using-proposed-api).

## Commands

The extension adds these commands to the Command Palette:

- `Ollama: Refresh Models`: reload the list of Ollama models shown in VS Code.
- `Ollama: Diagnose Models`: print model discovery information to the Ollama
  output channel for troubleshooting.

Use `Diagnose Models` if models are available in Ollama but do not appear in the VS Code model picker.

## Troubleshooting

If Ollama models do not appear:

1. Make sure Ollama is running.
2. Run `ollama list` and confirm models are available.
3. Run `Ollama: Refresh Models` from the Command Palette.
4. Run `Ollama: Diagnose Models` and check the `Ollama` output channel.

If a cloud model asks you to sign in, run `ollama signin`.

If an inference request takes more than 10 minutes to begin responding, increase
**Ollama: Inference Timeout Minutes** in VS Code Settings. The timeout only
affects inference requests made by this extension. Cancelling Chat still stops
the request immediately.
