# Ollama for VS Code (with Open WebUI Proxy Support)

Use Ollama models in VS Code Chat.

The Ollama extension adds models from your running Ollama server to the VS Code
model picker. This fork adds first-class support for routing requests through an **Open WebUI** instance using its [Ollama API Proxy](https://docs.openwebui.com/reference/api-endpoints/#ollama-api-proxy-support).

## Requirements

- Visual Studio Code 1.120 or newer.
- Ollama installed and running, *or* an Open WebUI instance configured with an Ollama backend.
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

## Manual Installation

Download the latest `.vsix` release from the [Releases](https://github.com/tpedretti/ollama-vscode-openwebui/releases) page, then install it using one of these methods:

#### Method 1 — VS Code UI (recommended)

1. Open VS Code.
2. Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Click the **...** (More Actions) menu in the top-right corner of the Extensions panel.
4. Select **Install from VSIX...** and navigate to the downloaded `.vsix` file.
5. Once installed, reload VS Code when prompted.

#### Method 2 — Command Line

1. Open a terminal and navigate to the folder containing the downloaded `.vsix` file.
2. Run:
   ```sh
   code --install-extension ./ollama-0.0.5.vsix
   ```
   (Replace `ollama-0.0.5.vsix` with the actual filename.)
3. Reload VS Code when prompted, or run `code --reload-window`.

#### Method 3 — Drag and Drop

1. Open VS Code and go to the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Drag the downloaded `.vsix` file from your file manager into the Extensions panel.
3. VS Code will automatically install the extension. Reload when prompted.

> **Note:** If you previously installed the Ollama extension from the Marketplace, the manual installation will override it. To revert, uninstall via the Extensions view or run `code --uninstall-extension ollama`.

### Verifying Installation

After installing, confirm the extension is active:

1. Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **Ollama** — you should see it listed with a green **Enable** or gear icon indicating it's installed.
3. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type `Ollama: Refresh Models`. If the command appears, the extension is active.

## Get started

1. Install the Ollama extension — see **Manual Installation** above.
2. Start Ollama *or* your Open WebUI instance.
3. Open Chat in VS Code.
4. Open the model picker at the bottom of the chat input.
5. Choose a model from the `Ollama` section.

The extension discovers models from `http://127.0.0.1:11434` by default.

## Open WebUI Proxy Mode

Open WebUI provides a transparent passthrough to the Ollama API via its `/ollama/` proxy prefix. When this mode is enabled, all requests are routed through your Open WebUI instance instead of hitting Ollama directly. This gives you access to Open WebUI's authentication, filters (inlet/outlet), rate limiting, and other middleware features.

### How it works

| | Direct Ollama | Via Open WebUI Proxy |
|---|---|---|
| **List models** | `GET http://localhost:11434/api/tags` | `GET http://localhost:3000/ollama/api/tags` |
| **Chat** | `POST http://localhost:11434/api/chat` | `POST http://localhost:3000/ollama/api/chat` |
| **Auth header** | *(none)* | `Authorization: Bearer <API_KEY>` |

### Enabling Open WebUI Proxy Mode

Open WebUI proxy mode requires two settings:

#### Option A — VS Code Settings UI (recommended)

1. Open **Settings** (`Ctrl+,` / `Cmd+,`).
2. Search for **Ollama**.
3. Check the box **"Use Open WebUI Ollama API Proxy"** (or enable **ollama.useOpenWebUIProxy**).
4. Enter your Open WebUI API key in the **"Open WebUI API Key"** field (**ollama.openWebUIApiKey**).
   - Get your key from Open WebUI → **Settings** → **Account** → **API Keys**.

#### Option B — `settings.json`

```json
{
  "ollama.endpoint": "http://127.0.0.1:3000",
  "ollama.useOpenWebUIProxy": true,
  "ollama.openWebUIApiKey": "your-api-key-here"
}
```

> **Note:** When proxy mode is enabled, the extension automatically prepends `/ollama` to your endpoint URL (e.g., `http://127.0.0.1:3000` becomes `http://127.0.0.1:3000/ollama`) and injects the Bearer token into every request. You do **not** need to include `/ollama` manually in your endpoint.

#### Option C — `chatLanguageModels.json` (per-model override)

```json
[
  {
    "vendor": "ollama-models",
    "name": "Ollama",
    "url": "http://127.0.0.1:3000",
    "useOpenWebUIProxy": true,
    "openWebUIApiKey": "your-api-key-here",
    "models": ["qwen3.6"],
    "headers": {}
  }
]
```

Provider configuration from VS Code takes precedence over workspace settings.

### Getting your Open WebUI API Key

1. Open Open WebUI in your browser.
2. Navigate to **Settings** → **Account**.
3. Find the **API Keys** section and generate or copy your key.
4. Paste it into the extension setting above.

---

## Commands

The extension adds these commands to the Command Palette:

- `Ollama: Refresh Models`: reload the list of Ollama models shown in VS Code.
- `Ollama: Diagnose Models`: print model discovery information to the Ollama
  output channel for troubleshooting.

Use `Diagnose Models` if models are available in Ollama but do not appear in the VS Code model picker. The diagnostics output now also reports whether Open WebUI proxy mode is active and your API key status (masked for security).

## Troubleshooting

If Ollama models do not appear:

1. Make sure Ollama (or Open WebUI) is running.
2. Run `ollama list` (or check Open WebUI's model list) and confirm models are available.
3. Run `Ollama: Refresh Models` from the Command Palette.
4. Run `Ollama: Diagnose Models` and check the `Ollama` output channel.

If using Open WebUI proxy mode:

- Ensure your **endpoint** points to Open WebUI (e.g., `http://127.0.0.1:3000`), not directly to Ollama.
- Verify your **API key** is valid and has permission to access models.
- Check that Open WebUI has an Ollama backend configured.

If a cloud model asks you to sign in, run `ollama signin`.
