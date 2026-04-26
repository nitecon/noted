import {defaultKeymap, history, historyKeymap} from "@codemirror/commands";
import {markdown} from "@codemirror/lang-markdown";
import {syntaxHighlighting, defaultHighlightStyle} from "@codemirror/language";
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  type Extension
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
  WidgetType
} from "@codemirror/view";
import MarkdownIt from "markdown-it";
import "./styles.css";

const idleRenderDelayMs = 20_000;

const md = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: true
});

const starterDoc = `# Live preview editor prototype

Edit any line to expose the raw Markdown. Move away from it and that line renders again.

## Formatting

This line has **strong text**, _emphasis_, \`inline code\`, and a [link](https://example.com).

- [x] Keep inactive Markdown readable
- [ ] Preserve the active line as raw Markdown
- Use CodeMirror decorations instead of contenteditable

> Quotes render while inactive, then switch back to raw syntax on focus.

\`\`\`rust
fn main() {
    println!("Code fences stay readable in the prototype.");
}
\`\`\`

Longer-term desktop integration can move this extension into the real editor module and wire persistence through noted-core-backed vault APIs.`;

class MarkdownLineWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly lineNumber: number
  ) {
    super();
  }

  eq(other: MarkdownLineWidget) {
    return other.source === this.source && other.lineNumber === this.lineNumber;
  }

  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = `cm-live-render ${lineKindClass(this.source)}`;
    wrapper.dataset.line = String(this.lineNumber);

    const content = document.createElement("span");
    content.className = "cm-live-render__content";
    content.innerHTML = renderLine(this.source);
    wrapper.append(content);

    return wrapper;
  }

  ignoreEvent() {
    return false;
  }
}

function renderLine(source: string) {
  const trimmed = source.trim();

  if (trimmed.length === 0) {
    return "";
  }

  const task = source.match(/^(\s*)[-*+]\s+\[([ xX])]\s+(.*)$/);
  if (task) {
    const checked = task[2].toLowerCase() === "x";
    return `<label class="task-line"><input type="checkbox" disabled ${
      checked ? "checked" : ""
    } /> <span>${md.renderInline(task[3])}</span></label>`;
  }

  const heading = source.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1].length;
    return `<span class="heading heading-${level}">${md.renderInline(heading[2])}</span>`;
  }

  const quote = source.match(/^>\s?(.*)$/);
  if (quote) {
    return `<span class="quote-line">${md.renderInline(quote[1])}</span>`;
  }

  const list = source.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  if (list) {
    return `<span class="list-line"><span class="list-line__marker">${list[2]}</span>${md.renderInline(
      list[3]
    )}</span>`;
  }

  const fence = source.match(/^```(.*)$/);
  if (fence) {
    return `<code class="fence-line">\`\`\`${escapeHtml(fence[1])}</code>`;
  }

  return md.renderInline(source);
}

function lineKindClass(source: string) {
  if (/^#{1,6}\s+/.test(source)) return "cm-live-render--heading";
  if (/^>\s?/.test(source)) return "cm-live-render--quote";
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(source)) return "cm-live-render--task";
  if (/^\s*([-*+]|\d+[.)])\s+/.test(source)) return "cm-live-render--list";
  if (/^```/.test(source)) return "cm-live-render--fence";
  return "cm-live-render--paragraph";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildLivePreviewDecorations(view: EditorView) {
  const activeLines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      activeLines.add(lineNumber);
    }
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (const {from, to} of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (!activeLines.has(line.number) && line.text.trim().length > 0) {
        builder.add(
          line.from,
          line.to,
          Decoration.replace({
            widget: new MarkdownLineWidget(line.text, line.number),
            inclusive: false
          })
        );
      }

      if (line.to >= to || line.to === view.state.doc.length) break;
      pos = line.to + 1;
    }
  }

  return builder.finish();
}

class LivePreviewPlugin implements PluginValue {
  decorations: DecorationSet;
  private idleTimer: number | undefined;

  constructor(private readonly view: EditorView) {
    this.decorations = buildLivePreviewDecorations(view);
    this.scheduleIdleRefresh();
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.focusChanged
    ) {
      this.decorations = buildLivePreviewDecorations(update.view);
      this.report(update.view.hasFocus ? "editing" : "blur rerendered");
      this.scheduleIdleRefresh();
    }
  }

  destroy() {
    if (this.idleTimer !== undefined) {
      window.clearTimeout(this.idleTimer);
    }
  }

  private scheduleIdleRefresh() {
    if (this.idleTimer !== undefined) {
      window.clearTimeout(this.idleTimer);
    }

    this.idleTimer = window.setTimeout(() => {
      this.decorations = buildLivePreviewDecorations(this.view);
      this.view.dispatch({effects: forceDecorationRefresh.of(null)});
      this.report("20s idle rerendered");
      this.scheduleIdleRefresh();
    }, idleRenderDelayMs);
  }

  private report(status: string) {
    const statusNode = document.querySelector("#render-status");
    if (statusNode) {
      statusNode.textContent = status;
    }
  }
}

const forceDecorationRefresh = StateEffect.define<null>();

function livePreview(): Extension {
  return ViewPlugin.fromClass(LivePreviewPlugin, {
    decorations: (plugin) => plugin.decorations
  });
}

const state = EditorState.create({
  doc: starterDoc,
  extensions: [
    history(),
    markdown(),
    syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
    livePreview(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.theme({
      "&": {
        height: "100%"
      },
      ".cm-scroller": {
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
      }
    })
  ]
});

new EditorView({
  state,
  parent: document.querySelector("#editor") as HTMLElement
});
