# Changelog

## 0.0.12

### Added

- Configure thinking effort per model using `ollama.thinkingLevels` in VS Code
  Settings JSON. Use the exact model name, including its tag, and a value supported
  by that model. Changes apply to the next request without restarting VS Code.
  Unset or unsupported values keep the server default.
  [#41](https://github.com/ollama/ollama-vscode/pull/41)

Thinking effort is configured through settings in this release. A dropdown and
native thinking-text display are not included. See the
[setup instructions](https://github.com/ollama/ollama-vscode#thinking-effort).

### Fixed

- Fix inflated token estimates after tool or media requests, which could cause
  conversations to compact too early.
  [#79](https://github.com/ollama/ollama-vscode/pull/79)
