# Development

Install dependencies and compile:

```sh
npm install
npm run compile
```

Open this folder in VS Code and run the Extension Development Host.

## Verify thinking effort settings

Run `npm test`, then use a separate VS Code profile and scratch workspace for
manual checks:

```sh
test_workspace=$(mktemp -d)
printf 'The test word is ORCHID.\n' > "$test_workspace/sample.txt"
code --new-window --profile "Ollama Thinking Test" \
  --extensionDevelopmentPath="$PWD" "$test_workspace"
```

Use stable VS Code without proposed API flags. In Settings, search for
**Ollama: Thinking Levels**, or open **Preferences: Open User Settings (JSON)**
and add an entry under `ollama.thinkingLevels` for your selected model. Use the
exact model identifier sent to Ollama, including its tag, and one of that
model's supported thinking values.

In **Chat: Manage Language Models**, add an Ollama group for the test endpoint.
For request verification, point only this group at a local capture proxy that
forwards `/api/*` unchanged to Ollama. Record the VS Code and Ollama versions,
model tag, `/api/show` response, outgoing chat body, and streamed response.

Inspect the selected model's supported values before testing, replacing the
placeholder with a model from `ollama list`:

```sh
curl http://127.0.0.1:11434/api/show -d '{"model":"<model-name:tag>"}'
```

Set one of the returned `thinking.values` without translating it to another
model's levels. Test models from different families, including a model with
boolean controls and one with named levels when available. An unset or
unsupported value omits `think`, leaving the server default unchanged. When
metadata is absent, only the existing GPT-OSS, DeepSeek V4, and GLM 5.2 mappings apply.
Unknown models without metadata, invalid metadata, and models with only one
supported value ignore overrides.

| Check | Action and expected result | Evidence |
| --- | --- | --- |
| Discovery and setting | Confirm the model appears in the picker and Thinking Levels appears in Settings. Add an entry using its exact model tag. | Visible setting and model discovery. |
| Outgoing values | For each supported value of the selected model, edit the setting and ask “What is 17 times 23? Answer with only the number.” Boolean and named values are sent unchanged. Repeat for a model from another family. | Captured `think` values, correct answers, and backend thinking chunks. |
| Answer display | Use a supported value that enables thinking and send a prompt. The final answer appears normally; thinking text is not inserted into the answer. | UI observation and response capture. |
| Tool history | In Agent mode, ask “Read sample.txt and tell me the test word.” Follow up with “What word did the file contain?” | Tool use in the UI; next request preserves tool calls and the matching tool result. |
| Defaults and ordinary chat | Remove the entry, then try an unsupported value. Also set an effort for a non-thinking model such as Phi-3 and ask “Reply with only READY.” | Normal answers; no outgoing `think` in these cases. |
| Cancellation | Stop a long thinking response, then ask a short question. | First request aborts; the next request completes. |
| Refresh and saved settings | Set an effort, refresh models, and restart the test window. Repeat after changing the endpoint/model metadata so that the saved value is unsupported. | Saved setting survives; unsupported saved values are omitted from requests. |

Report UI observations, real-model/extension-host tests, and mocked tests
separately. A settings schema assertion alone does not verify a visible control, and an
HTTP 200 alone does not prove that an effort value took effect.

## Configuration

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
    "vendor": "ollama-models",
    "name": "Ollama",
    "url": "http://127.0.0.1:11434",
    "models": ["qwen3.6"],
    "headers": {}
  }
]
```

If `models` is omitted, the extension lists every model returned by `/api/tags`.
Provider configuration from VS Code takes precedence over workspace settings.

## Package a VSIX

Build the extension package:

```sh
npm install
npm run compile
npx @vscode/vsce package --out ollama-0.0.1.vsix
```

Install the packaged VSIX:

```sh
code --install-extension ollama-0.0.1.vsix
```

You can also install a VSIX from VS Code by running `Extensions: Install from
VSIX...` from the Command Palette.
