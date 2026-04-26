# Noted

Noted is a cross-platform Markdown note app built around first-class CLI and
agent workflows. The long-term goal is to preserve the best parts of Obsidian
while making notes easy to search, outline, extract, and edit from AI agents.

## Current CLI

```bash
cargo run -p noted -- index /path/to/vault
cargo run -p noted -- index /path/to/vault --rebuild
cargo run -p noted -- search "query" /path/to/vault
cargo run -p noted -- search "query" /path/to/vault --limit 5
cargo run -p noted -- search "query" /path/to/vault --mode vector
cargo run -p noted -- outline /path/to/note.md
cargo run -p noted -- section /path/to/note.md "Heading"
```

The CLI and future desktop app share `noted-core`, so parsing and search
behavior stays consistent across both surfaces.

## Desktop App

The initial desktop shell lives in `apps/noted-desktop`. It is a Tauri 2 app
with a Vite-powered frontend.

```bash
cd apps/noted-desktop
npm install
npm run dev
```

For the native desktop window, run this from the same directory:

```bash
npm run tauri dev
```

If the global npm or Cargo cache has local permission issues, use writable
temporary caches:

```bash
npm install --cache /tmp/noted-npm-cache
CARGO_HOME=/tmp/noted-cargo-home cargo check
```

## Live Preview Prototype

The CodeMirror live-preview editor prototype is isolated from the desktop app
while the editor behavior is still being evaluated.

```bash
cd prototypes/editor-live-preview
npm install
npm run dev
```

## Workspace

- `crates/noted-core`: Markdown parsing, section extraction, and vault search.
- `crates/noted-cli`: Scriptable CLI for agent and terminal workflows.
- `apps/noted-desktop`: Tauri desktop shell with vault navigation, editor
  placeholder, and agent workspace placeholder.
- `prototypes/editor-live-preview`: CodeMirror live-preview editing prototype.
