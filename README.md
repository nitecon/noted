# Noted

Noted is a cross-platform Markdown note app built around first-class CLI and
agent workflows. The long-term goal is to preserve the best parts of Obsidian
while making notes easy to search, outline, extract, and edit from AI agents.

## Current CLI

```bash
cargo run -p noted -- index /path/to/vault
cargo run -p noted -- search "query" /path/to/vault
cargo run -p noted -- search "query" /path/to/vault --limit 5
cargo run -p noted -- search "query" /path/to/vault --mode vector
cargo run -p noted -- outline /path/to/note.md
cargo run -p noted -- section /path/to/note.md "Heading"
```

The CLI and future desktop app share `noted-core`, so parsing and search
behavior stays consistent across both surfaces.

## Workspace

- `crates/noted-core`: Markdown parsing, section extraction, and vault search.
- `crates/noted-cli`: Scriptable CLI for agent and terminal workflows.
