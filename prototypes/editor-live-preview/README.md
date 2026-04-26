# Noted Live Preview Editor Prototype

This is an isolated frontend prototype for Obsidian-style live preview editing.
It uses CodeMirror 6 decorations to render inactive Markdown lines while leaving
the active cursor line as raw Markdown.

## Run

```bash
npm install
npm run dev
```

Then open the local Vite URL, usually `http://127.0.0.1:5173/`.

## Behavior

- CodeMirror owns the editable document; there is no `contenteditable` editor.
- The active cursor line remains raw Markdown for direct editing.
- Visible inactive non-empty lines are replaced with rendered widgets.
- Blur and cursor movement rebuild the rendered decorations.
- A 20 second idle timer forces a rerender pass and updates the status pill.

## Prototype Limits

This is intentionally line-oriented. Single-line Markdown such as headings,
links, emphasis, inline code, block quotes, list items, and task list items
renders in place. Multi-line constructs such as full fenced code blocks and
nested lists are represented line by line rather than as complete Markdown
blocks. A production version should promote the decoration builder from
line-based rendering to syntax-tree-aware block ranges.
