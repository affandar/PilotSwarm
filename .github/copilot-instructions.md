# Copilot Instructions for durable-copilot-sdk

## Duroxide Bugs

When a bug is identified as originating in **duroxide** (the Rust-based durable orchestration runtime), do NOT attempt to work around it in the SDK or TUI layer. Instead:

1. Clearly explain the bug and its root cause in duroxide.
2. Insist on fixing the issue in the duroxide codebase itself.
3. Only implement a workaround if explicitly asked to by the user.

Duroxide is the foundational runtime — papering over its bugs at higher layers creates fragile, hard-to-maintain code.
