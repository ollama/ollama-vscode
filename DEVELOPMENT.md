# Development

Install dependencies and compile:

```sh
npm install
npm run compile
```

Open this folder in VS Code and run the Extension Development Host.

## Configuration

Configure the endpoint and optional request headers in VS Code settings:

```json
{
  "ollama.endpoint": "http://127.0.0.1:11434",
  "ollama.headers": {}
}
```

### Open WebUI Proxy Mode

To route requests through an Open WebUI instance using its Ollama API Proxy, enable:

```json
{
  "ollama.endpoint": "http://127.0.0.1:3000",
  "ollama.useOpenWebUIProxy": true,
  "ollama.openWebUIApiKey": "your-api-key-here"
}
```

When enabled, the extension automatically prepends `/ollama` to your endpoint URL and injects a Bearer token into every request. See the README for more details.

VS Code can also pass provider configuration through `chatLanguageModels.json`:

```json
[
  {
    "vendor": "ollama-models",
    "name": "Ollama",
    "url": "http://127.0.0.1:11434",
    "models": ["qwen3.6"],
    "headers": {},
    "useOpenWebUIProxy": false,
    "openWebUIApiKey": ""
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
