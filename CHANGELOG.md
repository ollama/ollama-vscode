# Changelog

## 0.0.12

### What's new

- You can now set the thinking effort for each model using `ollama.thinkingLevels`
  in VS Code Settings JSON. It applies to your next request, so you don't need to
  restart VS Code. Use the exact model name, including its tag, and a value that
  model supports. If you don't set one, or the value isn't supported, we'll keep
  the server default.
  [#41](https://github.com/ollama/ollama-vscode/pull/41)

For now, this is in Settings JSON. The dropdown and showing the model's thinking
in Chat aren't included in this release.
[Here's how to set it up](https://github.com/ollama/ollama-vscode#thinking-effort).

### Fixes

- We also fixed an issue where tool or media requests could make the estimated
  token count too high and cause conversations to compact earlier than they should.
  [#79](https://github.com/ollama/ollama-vscode/pull/79)
