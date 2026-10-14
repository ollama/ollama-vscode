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

## Remote SSH

The extension prefers to run on the SSH host. A local-only installation runs
locally; when installed both locally and remotely, the remote copy is preferred.
Use `Developer: Show Running Extensions` to check its location. The configured
Ollama URL must be reachable from that machine.

In VS Code 1.141.1, a local provider can discover models but cannot serve a Chat
participant running on the SSH host. Successful `Ollama: Diagnose Models`
output does not establish that Chat works across those hosts.

### Use a local Ollama server through SSH

Install the Ollama VS Code extension on the SSH host and keep the Ollama server
running locally. On your local machine, start a reverse tunnel using your usual
SSH destination:

```sh
ssh -N -T -o ExitOnForwardFailure=yes -R 127.0.0.1:21434:127.0.0.1:11434 user@remote-host
```

Keep the tunnel running. In the Remote SSH window, configure Remote settings:

```json
{
  "ollama.endpoint": "http://127.0.0.1:21434"
}
```

If an Ollama URL is configured through Manage Models, update it to the same
address; provider configuration takes precedence over settings.

Run `Ollama: Refresh Models`, select a model, and test a Chat request.

The SSH server must allow remote forwarding, and port 21434 must be available.
Use a trusted SSH host: other processes on that host can access the forwarded
endpoint.

Chat inference through this tunnel was verified with a remote test participant
on VS Code 1.141.1. Full Copilot Agent tool use remains untested.

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
