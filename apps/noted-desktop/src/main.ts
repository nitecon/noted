import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-dialog";
import {defaultKeymap, history, historyKeymap} from "@codemirror/commands";
import {markdown} from "@codemirror/lang-markdown";
import {defaultHighlightStyle, syntaxHighlighting} from "@codemirror/language";
import {EditorState, RangeSetBuilder, StateEffect, StateField, type Extension} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import MarkdownIt from "markdown-it";
import "./styles.css";

type FileNode = {
  name: string;
  path: string;
  kind: "markdown" | "code" | "asset";
};

type FolderNode = {
  name: string;
  path: string;
  files: FileNode[];
};

type AgentId = "codex" | "gemini" | "claude";
type ChatMode = "note" | "path";
type ChatRole = "assistant" | "user";

type AgentOption = {
  id: AgentId;
  label: string;
  command: string;
  models: string[];
  defaultModel: string;
  available: boolean;
};

type DetectedCommand = {
  command: string;
  available: boolean;
};

type VaultConfigState = {
  configPath: string;
  vault: string | null;
};

type VaultOpenState = {
  configPath: string;
  vault: string;
  documents: number;
  reused: number;
  updated: number;
  removed: number;
};

type FileContentState = {
  path: string;
  content: string;
};

type AgentRunResponse = {
  agent: string;
  model: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type ChatMessage = {
  id: number;
  role: ChatRole;
  label: string;
  content: string;
  meta?: string;
};

type ModelUpdate = {
  position: string;
  content: string;
};

type ParsedTable = {
  headers: string[];
  rows: string[][];
};

type DirectoryPickerHandle = {
  name: string;
};

type BrowserDirectoryPicker = Window &
  typeof globalThis & {
    showDirectoryPicker?: () => Promise<DirectoryPickerHandle>;
  };

type TreeMenuTarget = {
  x: number;
  y: number;
  kind: "root" | "folder" | "file";
  path: string;
};

type TabMenuTarget = {
  x: number;
  y: number;
  path: string;
};

type PendingMove = {
  x: number;
  y: number;
  kind: "folder" | "file";
  sourcePath: string;
  targetFolderPath: string;
};

const idleRenderDelayMs = 20_000;

const md = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: true,
});

let folders: FolderNode[] = [
  {
    name: "Inbox",
    path: "Inbox",
    files: [
      {name: "Project overview.md", path: "Inbox/Project overview.md", kind: "markdown"},
      {name: "Meeting capture.md", path: "Inbox/Meeting capture.md", kind: "markdown"},
      {name: "raw-import.json", path: "Inbox/raw-import.json", kind: "code"},
    ],
  },
  {
    name: "Noted",
    path: "Noted",
    files: [
      {name: "Desktop shell.md", path: "Noted/Desktop shell.md", kind: "markdown"},
      {name: "Agent bridge.md", path: "Noted/Agent bridge.md", kind: "markdown"},
      {name: "commands.ts", path: "Noted/commands.ts", kind: "code"},
    ],
  },
  {
    name: "Research",
    path: "Research",
    files: [
      {name: "Search experiments.md", path: "Research/Search experiments.md", kind: "markdown"},
      {name: "Vector notes.md", path: "Research/Vector notes.md", kind: "markdown"},
      {name: "fixtures.toml", path: "Research/fixtures.toml", kind: "code"},
    ],
  },
];

const agentOptions: AgentOption[] = [
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    models: ["default", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"],
    defaultModel: "default",
    available: false,
  },
  {
    id: "gemini",
    label: "Gemini",
    command: "gemini",
    models: ["default", "gemini-2.5-pro", "gemini-2.5-flash"],
    defaultModel: "default",
    available: false,
  },
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    models: ["default", "opus", "sonnet", "haiku"],
    defaultModel: "default",
    available: false,
  },
];

let showAllFiles = false;
let activeFolder = "Inbox";
let activeFile = "Inbox/Project overview.md";
let openFiles = ["Inbox/Project overview.md", "Noted/Desktop shell.md"];
let selectedAgent: AgentId = "codex";
let selectedModel = "default";
let chatMode: ChatMode = "note";
let chatMessages: ChatMessage[] = [];
let chatDraft = "";
let nextChatMessageId = 1;
let agentIsRunning = false;
let editingTitle = false;
let titleDraft = "";
let pointerInTree = false;
let treeScrollTop = 0;
let expandedFolders = new Set(folders.map((folder) => folder.path));
let rawTableFrom: number | null = null;
let currentVaultPath: string | null = null;
let configPath = "~/.noted/config.yml";
let firstRun = false;
let isOpeningVault = false;
let indexSummary = "Index pending";
let firstRunError: string | null = null;
let listenMode = false;
let voiceMenu: {x: number; y: number; text: string} | null = null;
let treeMenu: TreeMenuTarget | null = null;
let tabMenu: TabMenuTarget | null = null;
let draggedTreeItem: {kind: "folder" | "file"; path: string} | null = null;
let pendingMove: PendingMove | null = null;
let copiedTreePath: {kind: "folder" | "file"; path: string} | null = null;
let editorView: EditorView | null = null;
const noteTexts = new Map<string, string>();
const loadedFiles = new Set<string>();
const loadingFiles = new Set<string>();
const dirtyFiles = new Set<string>();
const saveTimers = new Map<string, number>();
const noteUndoStacks = new Map<string, string[]>();
const noteRedoStacks = new Map<string, string[]>();
let suppressNextSave = false;
const notedVersion = "0.0.0-source";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

const root = app;

function markdownFiles(folder: FolderNode) {
  return folder.files.filter((file) => showAllFiles || file.kind === "markdown");
}

function activeAgent() {
  return agentOptions.find((agent) => agent.id === selectedAgent) ?? agentOptions[0];
}

function render() {
  captureTransientUiState();
  persistEditorText();
  const agent = activeAgent();

  root.innerHTML = `
    <main class="app-shell">
      ${firstRun ? renderFirstRun() : ""}
      ${voiceMenu ? renderVoiceMenu() : ""}
      ${treeMenu ? renderTreeMenu() : ""}
      ${tabMenu ? renderTabMenu() : ""}
      ${pendingMove ? renderMoveDialog() : ""}
      <aside class="vault-pane" aria-label="Vault navigation">
        <header class="pane-header">
          <div>
            <p class="eyebrow">Vault</p>
            <h1>Noted</h1>
          </div>
          <button class="icon-button" type="button" aria-label="Create note">+</button>
        </header>

        <label class="search-box">
          <span class="sr-only">Search notes</span>
          <input type="search" placeholder="Search notes" />
        </label>

        <section class="vault-section" aria-labelledby="vault-tree-heading" data-root-menu="true">
          <div class="section-heading">
            <h2 id="vault-tree-heading">Folders</h2>
            <span>${showAllFiles ? "all files" : "markdown"}</span>
          </div>
          <nav class="tree" aria-label="Vault folders">
            ${renderVaultTree()}
          </nav>
        </section>

        <footer class="vault-footer">
          <div>
            <span>Noted</span>
            <strong>${notedVersion}</strong>
          </div>
          <div>
            <span>Path</span>
            <strong>${currentVaultPath ?? "No vault selected"}</strong>
          </div>
          <div>
            <span>Index</span>
            <strong id="index-summary">${indexSummary}</strong>
          </div>
        </footer>
      </aside>

      <section class="editor-pane" aria-label="Markdown editor">
        <nav class="open-tabs" aria-label="Open files">
          ${openFiles.map(renderOpenTab).join("")}
        </nav>

        <header class="editor-toolbar">
          <div>
            ${
              editingTitle
                ? `<input class="note-title-input" id="note-title-input" value="${escapeHtml(titleDraft)}" aria-label="Rename note" />`
                : `<button type="button" class="note-title-button" id="note-title-button" aria-label="Rename note">
                    ${escapeHtml(activeFileTitle())}
                  </button>`
            }
          </div>
          <div class="sync-state" aria-label="Document status">
            <button type="button" id="undo-note" ${canUndoNote(activeFile) ? "" : "disabled"}>Undo</button>
            <button type="button" id="redo-note" ${canRedoNote(activeFile) ? "" : "disabled"}>Redo</button>
            <button type="button" id="voice-document">Voice document</button>
            <button type="button" id="read-section">Read section</button>
          </div>
        </header>

        <div class="editor-shell" aria-label="Markdown live preview editor">
          <div id="editor"></div>
        </div>
      </section>

      <aside class="agent-pane" aria-label="Agent workspace">
        <header class="pane-header compact">
          <div>
            <p class="eyebrow">Workspace</p>
            <h2>Agent</h2>
          </div>
        </header>

        <div class="mode-toggle" role="tablist" aria-label="Chat context mode">
          <button type="button" class="mode-button ${
            chatMode === "note" ? "active" : ""
          }" data-mode="note" role="tab" aria-selected="${chatMode === "note"}">
            Note
          </button>
          <button type="button" class="mode-button ${
            chatMode === "path" ? "active" : ""
          }" data-mode="path" role="tab" aria-selected="${chatMode === "path"}">
            Path
          </button>
        </div>
        <section class="chat-thread" aria-label="Chat">
          ${renderChatThread(agent)}
        </section>

        ${renderChatInput(agent)}
      </aside>
    </main>
  `;

  bindEvents();
  mountEditor();
  restoreTransientUiState();
  void loadActiveFile();
}

function renderVoiceMenu() {
  return `
    <div class="voice-menu" style="left: ${voiceMenu?.x ?? 0}px; top: ${
      voiceMenu?.y ?? 0
    }px;" role="menu">
      <button type="button" id="voice-over-selection" role="menuitem">
        Voice over
      </button>
    </div>
  `;
}

function renderTreeMenu() {
  const items = treeMenu ? treeMenuItems(treeMenu) : [];
  return `
    <div class="tree-menu" style="left: ${treeMenu?.x ?? 0}px; top: ${
      treeMenu?.y ?? 0
    }px;" role="menu">
      ${items
        .map(
          (item) => `
            <button type="button" data-menu-action="${item.action}" role="menuitem">
              ${item.label}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderTabMenu() {
  return `
    <div class="tree-menu tab-menu" style="left: ${tabMenu?.x ?? 0}px; top: ${
      tabMenu?.y ?? 0
    }px;" role="menu">
      <button type="button" data-tab-menu-action="close" role="menuitem">Close</button>
      <button type="button" data-tab-menu-action="close-left" role="menuitem">Close left</button>
      <button type="button" data-tab-menu-action="close-right" role="menuitem">Close right</button>
    </div>
  `;
}

function renderMoveDialog() {
  const targetFolder = folders.find((folder) => folder.path === pendingMove?.targetFolderPath);
  return `
    <div class="move-menu" style="left: ${pendingMove?.x ?? 0}px; top: ${
      pendingMove?.y ?? 0
    }px;" role="menu" aria-label="Confirm move">
      <p>
        Move ${pendingMove?.kind ?? "item"} <strong>${pendingMove?.sourcePath ?? ""}</strong> to
        <strong>${targetFolder?.path ?? pendingMove?.targetFolderPath ?? ""}</strong>?
      </p>
      <div class="move-menu-actions">
        <button type="button" class="confirm-yes" id="confirm-move">Yes</button>
        <button type="button" id="cancel-move">No</button>
      </div>
    </div>
  `;
}

class MarkdownLineWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly lineNumber: number,
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

class MarkdownBlockWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly kind: "code" | "table",
    private readonly from: number,
  ) {
    super();
  }

  eq(other: MarkdownBlockWidget) {
    return other.source === this.source && other.kind === this.kind && other.from === this.from;
  }

  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = `cm-live-render-block cm-live-render-block--${this.kind}`;
    wrapper.dataset.from = String(this.from);
    if (this.kind === "table") {
      wrapper.append(renderEditableTable(this.source, this.from));
    } else {
      wrapper.innerHTML = md.render(this.source);
    }
    return wrapper;
  }

  ignoreEvent() {
    return this.kind === "table";
  }
}

class LivePreviewIdlePlugin implements PluginValue {
  private idleTimer: number | undefined;

  constructor(private readonly view: EditorView) {
    this.scheduleIdleRefresh();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
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
      this.view.dispatch({effects: forceDecorationRefresh.of(null)});
      this.scheduleIdleRefresh();
    }, idleRenderDelayMs);
  }
}

const forceDecorationRefresh = StateEffect.define<null>();

const livePreviewField = StateField.define<DecorationSet>({
  create(state) {
    return buildLivePreviewDecorations(state);
  },
  update(decorations, transaction) {
    if (
      transaction.docChanged ||
      transaction.selection ||
      transaction.effects.some((effect) => effect.is(forceDecorationRefresh))
    ) {
      return buildLivePreviewDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function livePreview(): Extension {
  return [livePreviewField, ViewPlugin.fromClass(LivePreviewIdlePlugin)];
}

function renderLine(source: string) {
  const trimmed = source.trim();
  if (!trimmed) {
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
      list[3],
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

function renderEditableTable(source: string, from: number) {
  const parsed = parseMarkdownTable(source);
  const table = document.createElement("table");
  table.className = "editable-table";
  table.dataset.from = String(from);

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  parsed.headers.forEach((value, columnIndex) => {
    const th = document.createElement("th");
    th.append(tableCellInput(from, "header", 0, columnIndex, value));
    headerRow.append(th);
  });
  const actionHeader = document.createElement("th");
  actionHeader.className = "editable-table__actions";
  const addColumnButton = document.createElement("button");
  addColumnButton.type = "button";
  addColumnButton.textContent = "+";
  addColumnButton.title = "Add column";
  addColumnButton.dataset.tableAction = "add-column";
  addColumnButton.dataset.tableFrom = String(from);
  actionHeader.append(addColumnButton);
  headerRow.append(actionHeader);
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  const rows = [...parsed.rows, parsed.headers.map(() => "")];
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    for (let columnIndex = 0; columnIndex < parsed.headers.length; columnIndex += 1) {
      const td = document.createElement("td");
      td.append(tableCellInput(from, "body", rowIndex, columnIndex, row[columnIndex] ?? ""));
      tr.append(td);
    }
    const actionCell = document.createElement("td");
    actionCell.className = "editable-table__actions";
    tr.append(actionCell);
    tbody.append(tr);
  });
  table.append(tbody);

  return table;
}

function tableCellInput(
  from: number,
  section: "header" | "body",
  rowIndex: number,
  columnIndex: number,
  value: string,
) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.dataset.tableFrom = String(from);
  input.dataset.tableSection = section;
  input.dataset.tableRow = String(rowIndex);
  input.dataset.tableColumn = String(columnIndex);
  input.dataset.committedValue = value;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      applyEditableTableChange(input);
      focusEditableTableCell(input, event.shiftKey ? "previous" : "next");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      applyEditableTableChange(input);
      insertEditableTableRow(input, event.shiftKey ? "above" : "below");
    }
  });
  return input;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildLivePreviewDecorations(state: EditorState) {
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      activeLines.add(lineNumber);
    }
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const block = inactiveBlockAt(state, line.number, activeLines);
    if (block) {
      builder.add(
        block.from,
        block.to,
        Decoration.replace({
          widget: new MarkdownBlockWidget(block.source, block.kind, block.from),
          block: true,
          inclusive: false,
        }),
      );
      lineNumber = block.endLine;
      continue;
    }

    if (!activeLines.has(line.number) && line.text.trim().length > 0) {
      builder.add(
        line.from,
        line.to,
        Decoration.replace({
          widget: new MarkdownLineWidget(line.text, line.number),
          inclusive: false,
        }),
      );
    }
  }

  return builder.finish();
}

function inactiveBlockAt(state: EditorState, lineNumber: number, activeLines: Set<number>) {
  return fencedCodeBlockAt(state, lineNumber, activeLines) ?? tableBlockAt(state, lineNumber, activeLines);
}

function fencedCodeBlockAt(state: EditorState, lineNumber: number, activeLines: Set<number>) {
  const start = state.doc.line(lineNumber);
  const fence = start.text.match(/^\s*(```+|~~~+)/);
  if (!fence) {
    return null;
  }

  const marker = fence[1][0];
  let endLineNumber = lineNumber;
  for (let candidate = lineNumber + 1; candidate <= state.doc.lines; candidate += 1) {
    const line = state.doc.line(candidate);
    if (new RegExp(`^\\s*${marker}{3,}\\s*$`).test(line.text)) {
      endLineNumber = candidate;
      break;
    }
    endLineNumber = candidate;
  }

  if (blockTouchesActiveLine(lineNumber, endLineNumber, activeLines)) {
    return null;
  }

  const end = state.doc.line(endLineNumber);
  return {
    kind: "code" as const,
    from: start.from,
    to: end.to,
    endLine: endLineNumber,
    source: state.doc.sliceString(start.from, end.to),
  };
}

function tableBlockAt(state: EditorState, lineNumber: number, activeLines: Set<number>) {
  if (lineNumber >= state.doc.lines) {
    return null;
  }

  const header = state.doc.line(lineNumber);
  const separator = state.doc.line(lineNumber + 1);
  if (!looksLikeTableRow(header.text) || !looksLikeTableSeparator(separator.text)) {
    return null;
  }

  let endLineNumber = lineNumber + 1;
  for (let candidate = lineNumber + 2; candidate <= state.doc.lines; candidate += 1) {
    const line = state.doc.line(candidate);
    if (!looksLikeTableRow(line.text)) {
      break;
    }
    endLineNumber = candidate;
  }

  const end = state.doc.line(endLineNumber);
  if (rawTableFrom !== null && rawTableFrom >= header.from && rawTableFrom <= end.to) {
    if (blockTouchesActiveLine(lineNumber, endLineNumber, activeLines)) {
      return null;
    }
    rawTableFrom = null;
  }

  return {
    kind: "table" as const,
    from: header.from,
    to: end.to,
    endLine: endLineNumber,
    source: state.doc.sliceString(header.from, end.to),
  };
}

function looksLikeTableRow(text: string) {
  return text.includes("|") && text.trim().length > 0;
}

function looksLikeTableSeparator(text: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text);
}

function parseMarkdownTable(source: string): ParsedTable {
  const lines = source.split("\n").filter((line) => line.trim().length > 0);
  const headers = splitTableRow(lines[0] ?? "");
  const rows = lines.slice(2).map(splitTableRow);
  return {
    headers,
    rows: rows.map((row) => normalizeTableRow(row, headers.length)),
  };
}

function splitTableRow(row: string) {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function normalizeTableRow(row: string[], width: number) {
  return Array.from({length: width}, (_, index) => row[index] ?? "");
}

function serializeMarkdownTable(table: ParsedTable) {
  const headers = table.headers.map(cleanTableCell);
  const rows = table.rows
    .map((row) => normalizeTableRow(row, headers.length).map(cleanTableCell))
    .filter((row) => row.some((cell) => cell.trim().length > 0));

  return [
    markdownTableRow(headers),
    markdownTableRow(headers.map((header) => "-".repeat(Math.max(3, header.length)))),
    ...rows.map(markdownTableRow),
  ].join("\n");
}

function markdownTableRow(cells: string[]) {
  return `| ${cells.join(" | ")} |`;
}

function cleanTableCell(value: string) {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function applyEditableTableChange(input: HTMLInputElement) {
  if (!editorView || !activeFile) {
    return;
  }

  if (input.dataset.committedValue === input.value) {
    return;
  }

  const from = Number(input.dataset.tableFrom);
  const columnIndex = Number(input.dataset.tableColumn);
  const rowIndex = Number(input.dataset.tableRow);
  const section = input.dataset.tableSection;
  if (!Number.isFinite(from) || !Number.isFinite(columnIndex) || !Number.isFinite(rowIndex)) {
    return;
  }

  const state = editorView.state;
  const line = state.doc.lineAt(Math.min(from, state.doc.length));
  const block = tableBlockAt(state, line.number, new Set());
  if (!block) {
    return;
  }

  const parsed = parseMarkdownTable(block.source);
  if (section === "header") {
    parsed.headers[columnIndex] = input.value;
  } else {
    parsed.rows[rowIndex] = normalizeTableRow(parsed.rows[rowIndex] ?? [], parsed.headers.length);
    parsed.rows[rowIndex][columnIndex] = input.value;
  }

  const current = state.doc.toString();
  const nextSource = serializeMarkdownTable(parsed);
  if (nextSource === block.source) {
    input.dataset.committedValue = input.value;
    return;
  }

  input.dataset.committedValue = input.value;
  recordNoteUndo(activeFile, current);
  editorView.dispatch({
    changes: {
      from: block.from,
      to: block.to,
      insert: nextSource,
    },
  });
}

function focusEditableTableCell(input: HTMLInputElement, direction: "next" | "previous") {
  const current = tableCellAddress(input);
  if (!current) {
    return;
  }

  const rowCount = input.closest("tbody")?.querySelectorAll("tr").length ?? current.rowIndex + 1;
  const lastRow = rowCount - 1;
  const lastColumn = current.columnCount - 1;
  let nextSection: "header" | "body" = current.section;
  let nextRow = current.rowIndex;
  let nextColumn = current.columnIndex;

  if (direction === "next") {
    if (nextColumn < lastColumn) {
      nextColumn += 1;
    } else if (nextSection === "header") {
      nextSection = "body";
      nextRow = 0;
      nextColumn = 0;
    } else if (nextRow < lastRow) {
      nextRow += 1;
      nextColumn = 0;
    } else {
      nextRow += 1;
      nextColumn = 0;
    }
  } else if (nextColumn > 0) {
    nextColumn -= 1;
  } else if (nextSection === "body" && nextRow > 0) {
    nextRow -= 1;
    nextColumn = lastColumn;
  } else if (nextSection === "body") {
    nextSection = "header";
    nextColumn = lastColumn;
  } else {
    nextSection = "body";
    nextRow = lastRow;
    nextColumn = lastColumn;
  }

  focusEditableTableCellByAddress(current.from, nextSection, nextRow, nextColumn);
}

function insertEditableTableRow(input: HTMLInputElement, position: "above" | "below") {
  if (!editorView || !activeFile) {
    return;
  }

  const current = tableCellAddress(input);
  if (!current) {
    return;
  }

  const block = editableTableBlock(current.from);
  if (!block) {
    return;
  }

  const parsed = parseMarkdownTable(block.source);
  const rows = parsed.rows.length ? [...parsed.rows] : [parsed.headers.map(() => "")];
  const baseIndex = current.section === "header" ? 0 : current.rowIndex + (position === "below" ? 1 : 0);
  rows.splice(baseIndex, 0, parsed.headers.map(() => ""));
  parsed.rows = rows;

  commitEditableTable(block, parsed);
  focusEditableTableCellByAddress(current.from, "body", baseIndex, current.columnIndex);
}

function addEditableTableColumn(from: number) {
  if (!editorView || !activeFile) {
    return;
  }

  const block = editableTableBlock(from);
  if (!block) {
    return;
  }

  const parsed = parseMarkdownTable(block.source);
  parsed.headers.push("Column");
  parsed.rows = parsed.rows.map((row) => [...normalizeTableRow(row, parsed.headers.length - 1), ""]);
  commitEditableTable(block, parsed);
  focusEditableTableCellByAddress(from, "header", 0, parsed.headers.length - 1);
}

function editableTableBlock(from: number) {
  if (!editorView || !Number.isFinite(from)) {
    return null;
  }

  const state = editorView.state;
  const line = state.doc.lineAt(Math.min(from, state.doc.length));
  return tableBlockAt(state, line.number, new Set());
}

function commitEditableTable(
  block: NonNullable<ReturnType<typeof tableBlockAt>>,
  parsed: ParsedTable,
) {
  if (!editorView || !activeFile) {
    return;
  }

  const current = editorView.state.doc.toString();
  const nextSource = serializeMarkdownTable(parsed);
  if (nextSource === block.source) {
    return;
  }

  recordNoteUndo(activeFile, current);
  editorView.dispatch({
    changes: {
      from: block.from,
      to: block.to,
      insert: nextSource,
    },
  });
}

function focusEditableTableCellByAddress(
  from: number,
  section: "header" | "body",
  rowIndex: number,
  columnIndex: number,
) {
  window.requestAnimationFrame(() => {
    const selector = [
      `[data-table-from="${from}"]`,
      `[data-table-section="${section}"]`,
      `[data-table-row="${rowIndex}"]`,
      `[data-table-column="${columnIndex}"]`,
    ].join("");
    const nextInput = document.querySelector<HTMLInputElement>(selector);
    nextInput?.focus();
    nextInput?.select();
  });
}

function tableCellAddress(input: HTMLInputElement) {
  const from = Number(input.dataset.tableFrom);
  const rowIndex = Number(input.dataset.tableRow);
  const columnIndex = Number(input.dataset.tableColumn);
  const section = input.dataset.tableSection;
  const columnCount = input.closest("tr")?.querySelectorAll<HTMLInputElement>("[data-table-column]").length ?? 0;
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(rowIndex) ||
    !Number.isFinite(columnIndex) ||
    (section !== "header" && section !== "body") ||
    columnCount < 1
  ) {
    return null;
  }

  return {
    from,
    section: section as "header" | "body",
    rowIndex,
    columnIndex,
    columnCount,
  };
}

function tableTouchesEditFocus(state: EditorState, start: number, end: number, activeLines: Set<number>) {
  if (blockTouchesActiveLine(start, end, activeLines)) {
    return true;
  }

  const nextLineNumber = end + 1;
  if (nextLineNumber <= state.doc.lines && activeLines.has(nextLineNumber)) {
    return state.doc.line(nextLineNumber).text.trim() === "";
  }

  return false;
}

function blockTouchesActiveLine(start: number, end: number, activeLines: Set<number>) {
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    if (activeLines.has(lineNumber)) {
      return true;
    }
  }
  return false;
}

function treeMenuItems(target: TreeMenuTarget) {
  if (target.kind === "root") {
    return [
      {action: "create-file", label: "Create root file"},
      {action: "create-folder", label: "Create root folder"},
      ...(copiedTreePath ? [{action: "paste", label: "Paste"}] : []),
    ];
  }

  if (target.kind === "folder") {
    return [
      {action: "create-file", label: "New note"},
      {action: "create-folder", label: "New folder"},
      {action: "rename", label: "Rename"},
      {action: "duplicate", label: "Duplicate"},
      {action: "copy", label: "Copy"},
      ...(copiedTreePath ? [{action: "paste", label: "Paste"}] : []),
      {action: "delete", label: "Delete"},
    ];
  }

  return [
    {action: "rename", label: "Rename"},
    {action: "duplicate", label: "Duplicate"},
    {action: "copy", label: "Copy"},
    {action: "delete", label: "Delete"},
  ];
}

function renderChatThread(agent: AgentOption) {
  const status = `${agent.available ? "Command detected in PATH." : "Command not detected yet."} ${
    listenMode
      ? `Voice-to-text will send to ${agent.label} using ${selectedModel} after a 5 second pause.`
      : chatMode === "note"
        ? "The active note will be attached to each request."
        : "The open vault path and selected file list will be attached to each request."
  }`;
  const messages = chatMessages.length
    ? chatMessages
    : [
        {
          id: 0,
          role: "assistant" as const,
          label: agent.label,
          content: status,
        },
      ];

  return `
    ${messages.map(renderChatMessage).join("")}
    ${
      agentIsRunning
        ? `<article class="message assistant pending">
            <span class="message-label">${escapeHtml(agent.label)}</span>
            <div class="thinking-bubbles" aria-label="Agent thinking">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <p>Running ${escapeHtml(selectedModel)}</p>
          </article>`
        : ""
    }
  `;
}

function renderChatMessage(message: ChatMessage) {
  return `
    <article class="message ${message.role}">
      <span class="message-label">${escapeHtml(message.label)}</span>
      ${message.meta ? `<span class="message-meta">${escapeHtml(message.meta)}</span>` : ""}
      <p>${escapeHtml(message.content)}</p>
    </article>
  `;
}

function renderChatInput(agent: AgentOption) {
  if (listenMode && chatMode === "note") {
    return `
      <section class="listen-panel" aria-label="Listen mode active">
        <div class="listen-indicator">
          <span></span>
          <div>
            <strong>Listening</strong>
            <p>After a 5 second pause, transcription will be sent to ${agent.label} using ${selectedModel}.</p>
          </div>
        </div>
        <button type="button" id="back-to-typing">Back to typing</button>
      </section>
    `;
  }

  return `
    ${chatMode === "note" ? '<button type="button" class="listen-toggle" id="listen-toggle">Listen mode</button>' : ""}
    <form class="prompt-box">
      <label class="sr-only" for="agent-prompt">Message agent</label>
      <textarea id="agent-prompt" rows="3" placeholder="${
        chatMode === "note" ? "Ask about this note" : "Use @file and search/list/outline/section"
      }" ${agentIsRunning ? "disabled" : ""}>${escapeHtml(chatDraft)}</textarea>
      <div class="prompt-actions">
        <div class="agent-controls" aria-label="Agent and model selection">
          <label>
            <span>Agent</span>
            <select id="agent-select">
              ${agentOptions
                .map(
                  (option) => `
                    <option value="${option.id}" ${option.id === selectedAgent ? "selected" : ""}>
                      ${option.label}${option.available ? "" : " (missing)"}
                    </option>
                  `,
                )
                .join("")}
            </select>
          </label>
          <label>
            <span>Model</span>
            <select id="model-select">
              ${agent.models
                .map(
                  (model) => `
                    <option value="${model}" ${model === selectedModel ? "selected" : ""}>
                      ${model}${model === agent.defaultModel ? " default" : ""}
                    </option>
                  `,
                )
                .join("")}
            </select>
          </label>
        </div>
        <button type="submit" ${agentIsRunning ? "disabled" : ""}>${agentIsRunning ? "Running" : "Send"}</button>
      </div>
    </form>
  `;
}

function renderFirstRun() {
  return `
    <section class="first-run" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
      <div class="first-run-panel">
        <p class="eyebrow">First run</p>
        <h2 id="first-run-title">Select your main notes folder</h2>
        <p>
          Choose the folder that contains your primary Markdown notes.
        </p>
        ${firstRunError ? `<p class="form-error">${firstRunError}</p>` : ""}
        <button type="button" id="browse-vault" ${isOpeningVault ? "disabled" : ""}>
          ${isOpeningVault ? "Opening..." : "Browse"}
        </button>
      </div>
    </section>
  `;
}

function renderVaultTree(): string {
  const rootFolder = folders.find((folder) => folder.path === ".");
  if (rootFolder) {
    return renderFolder(rootFolder);
  }

  return childFolders(".").map(renderFolder).join("");
}

function renderFolder(folder: FolderNode): string {
  const files = markdownFiles(folder);
  const children = childFolders(folder.path);
  const isRoot = folder.path === ".";
  const folderLabel = isRoot ? vaultRootName() : folder.name;
  const isExpanded = expandedFolders.has(folder.path);
  const depth = folderDepth(folder.path);
  return `
    <div class="tree-folder ${isRoot ? "root-folder" : ""}" style="--tree-depth: ${depth}" data-folder="${folder.path}" draggable="true">
      <button type="button" class="tree-item ${isRoot ? "root-item" : ""} ${
        folder.path === activeFolder ? "active" : ""
      }">
        <span class="tree-main">
          <span class="disclosure">${isExpanded ? "▾" : "▸"}</span>
          <span class="tree-label">${folderLabel}</span>
        </span>
        <span class="tree-count">${files.length}</span>
      </button>
      ${
        isExpanded
          ? `<div class="tree-children">
              ${children.map(renderFolder).join("")}
              ${files
                .map(
                  (file) => `
                    <button type="button" class="file-item ${
                      file.path === activeFile ? "active" : ""
                    } ${file.kind !== "markdown" ? "non-markdown" : ""}" data-file="${file.path}" draggable="true">
                      <span class="tree-label">${file.name}</span>
                    </button>
                  `,
                )
                .join("")}
            </div>`
          : ""
      }
    </div>
  `;
}

function childFolders(parentPath: string) {
  return folders
    .filter((folder) => folder.path !== "." && parentFolderPath(folder.path) === parentPath)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function renderOpenTab(path: string) {
  const fileName = path.split("/").at(-1) ?? path;
  return `
    <button type="button" class="open-tab ${
      path === activeFile ? "active" : ""
    }" data-open-file="${path}">
      <span class="tab-title">${fileName}</span>
      <span class="tab-path">${path.includes("/") ? path.split("/")[0] : ""}</span>
      <span class="tab-close" role="button" tabindex="0" aria-label="Close ${fileName}" data-close-tab="${path}">&times;</span>
    </button>
  `;
}

function bindEvents() {
  const tree = document.querySelector(".tree");

  tree?.addEventListener("scroll", () => {
    treeScrollTop = tree.scrollTop;
  });

  tree?.addEventListener("mouseenter", (event) => {
    const mouseEvent = event as MouseEvent;
    pointerInTree = true;
    updateAllFilesReveal(mouseEvent.metaKey || mouseEvent.ctrlKey);
  });

  tree?.addEventListener("mouseleave", () => {
    pointerInTree = false;
    if (showAllFiles) {
      showAllFiles = false;
      render();
    }
  });

  tree?.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    const folder = (event.target as HTMLElement).closest<HTMLElement>("[data-folder]");
    const file = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-file]");

    if (action?.dataset.action) {
      event.preventDefault();
      handleTreeAction(action);
      return;
    }

    if (file?.dataset.file) {
      activeFile = file.dataset.file;
      activeFolder = folderForFile(activeFile) ?? activeFolder;
      addOpenFile(activeFile);
      render();
      return;
    }

    if (folder?.dataset.folder) {
      activeFolder = folder.dataset.folder;
      if ((event as MouseEvent).metaKey || (event as MouseEvent).ctrlKey) {
        expandAllFolders();
      } else {
        toggleFolder(activeFolder);
      }
      render();
    }
  });

  tree?.addEventListener("contextmenu", (event) => {
    const mouseEvent = event as MouseEvent;
    const file = (event.target as HTMLElement).closest<HTMLElement>("[data-file]");
    if (file?.dataset.file) {
      event.preventDefault();
      openTreeMenu(mouseEvent, "file", file.dataset.file);
      render();
      return;
    }

    const folder = (event.target as HTMLElement).closest<HTMLElement>("[data-folder]");
    if (!folder?.dataset.folder) {
      event.preventDefault();
      openTreeMenu(mouseEvent, "root", ".");
      render();
      return;
    }

    event.preventDefault();
    openTreeMenu(mouseEvent, folder.dataset.folder === "." ? "root" : "folder", folder.dataset.folder);
    render();
  });

  tree?.addEventListener("dragstart", (event) => {
    const dragEvent = event as DragEvent;
    const file = (event.target as HTMLElement).closest<HTMLElement>("[data-file]");
    const folder = (event.target as HTMLElement).closest<HTMLElement>("[data-folder]");
    if (file?.dataset.file) {
      draggedTreeItem = {kind: "file", path: file.dataset.file};
    } else if (folder?.dataset.folder && folder.dataset.folder !== ".") {
      draggedTreeItem = {kind: "folder", path: folder.dataset.folder};
    } else {
      draggedTreeItem = null;
    }

    if (draggedTreeItem && dragEvent.dataTransfer) {
      dragEvent.dataTransfer.effectAllowed = "move";
      dragEvent.dataTransfer.setData("text/plain", draggedTreeItem.path);
    }
  });

  tree?.addEventListener("dragover", (event) => {
    if ((event.target as HTMLElement).closest("[data-folder]") && draggedTreeItem) {
      event.preventDefault();
    }
  });

  tree?.addEventListener("drop", (event) => {
    const targetFolder = (event.target as HTMLElement).closest<HTMLElement>("[data-folder]");
    if (!targetFolder?.dataset.folder || !draggedTreeItem) {
      return;
    }

    event.preventDefault();
    requestMoveConfirmation(draggedTreeItem, targetFolder.dataset.folder, event as DragEvent);
    draggedTreeItem = null;
  });

  document.querySelectorAll<HTMLButtonElement>("[data-open-file]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-close-tab]")) {
        return;
      }
      activeFile = button.dataset.openFile ?? activeFile;
      activeFolder = folderForFile(activeFile) ?? activeFolder;
      render();
    });

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      tabMenu = {
        x: event.clientX,
        y: event.clientY,
        path: button.dataset.openFile ?? activeFile,
      };
      render();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-close-tab]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeTab(button.dataset.closeTab ?? activeFile);
      render();
    });
  });

  document.querySelector<HTMLSelectElement>("#agent-select")?.addEventListener("change", (event) => {
    selectedAgent = (event.target as HTMLSelectElement).value as AgentId;
    selectedModel = activeAgent().defaultModel;
    render();
  });

  document.querySelector<HTMLSelectElement>("#model-select")?.addEventListener("change", (event) => {
    selectedModel = (event.target as HTMLSelectElement).value;
  });

  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      chatMode = button.dataset.mode as ChatMode;
      if (chatMode !== "note") {
        listenMode = false;
      }
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#listen-toggle")?.addEventListener("click", () => {
    listenMode = true;
    render();
  });

  document.querySelector<HTMLButtonElement>("#back-to-typing")?.addEventListener("click", () => {
    listenMode = false;
    render();
  });

  document.querySelector<HTMLButtonElement>("#undo-note")?.addEventListener("click", () => {
    undoNote(activeFile);
  });

  document.querySelector<HTMLButtonElement>("#redo-note")?.addEventListener("click", () => {
    redoNote(activeFile);
  });

  document.querySelector<HTMLButtonElement>("#note-title-button")?.addEventListener("click", () => {
    editingTitle = true;
    titleDraft = activeFileTitle();
    render();
  });

  const titleInput = document.querySelector<HTMLInputElement>("#note-title-input");
  titleInput?.focus();
  titleInput?.select();
  titleInput?.addEventListener("input", (event) => {
    titleDraft = sanitizeNoteTitle((event.currentTarget as HTMLInputElement).value);
    (event.currentTarget as HTMLInputElement).value = titleDraft;
  });
  titleInput?.addEventListener("blur", () => {
    void commitActiveTitleRename();
  });
  titleInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitActiveTitleRename();
    } else if (event.key === "Escape") {
      editingTitle = false;
      titleDraft = "";
      render();
    }
  });

  document.querySelector<HTMLButtonElement>("#voice-document")?.addEventListener("click", () => {
    indexSummary = "Voice document queued";
    render();
  });

  document.querySelector<HTMLButtonElement>("#read-section")?.addEventListener("click", () => {
    indexSummary = "Read section queued";
    render();
  });

  document.querySelector<HTMLButtonElement>("#voice-over-selection")?.addEventListener("click", () => {
    indexSummary = "Voice over queued";
    voiceMenu = null;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-menu-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      await handleTreeMenuAction(button.dataset.menuAction ?? "");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-tab-menu-action]").forEach((button) => {
    button.addEventListener("click", () => {
      handleTabMenuAction(button.dataset.tabMenuAction ?? "");
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#confirm-move")?.addEventListener("click", async () => {
    const move = pendingMove;
    pendingMove = null;
    if (move) {
      await moveFile(move.kind, move.sourcePath, move.targetFolderPath);
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#cancel-move")?.addEventListener("click", () => {
    pendingMove = null;
    render();
  });

  document.querySelector<HTMLElement>("[data-root-menu]")?.addEventListener("contextmenu", (event) => {
    if ((event.target as HTMLElement).closest("[data-file], [data-folder]")) {
      return;
    }

    const mouseEvent = event as MouseEvent;
    event.preventDefault();
    openTreeMenu(mouseEvent, "root", ".");
    render();
  });

  document.querySelector(".editor-shell")?.addEventListener("contextmenu", (event) => {
    const selection = window.getSelection()?.toString().trim() || selectedEditorText();
    if (!selection) {
      voiceMenu = null;
      return;
    }

    event.preventDefault();
    voiceMenu = {
      x: (event as MouseEvent).clientX,
      y: (event as MouseEvent).clientY,
      text: selection,
    };
    render();
  });

  document.querySelector(".editor-shell")?.addEventListener("click", (event) => {
    const mouseEvent = event as MouseEvent;
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(".cm-live-render a, .cm-live-render-block a");
    if (link && (mouseEvent.metaKey || mouseEvent.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      openExternalLink(link.href);
      return;
    }

    const table = (event.target as HTMLElement).closest<HTMLElement>(".cm-live-render-block--table");
    if (table?.dataset.from && (mouseEvent.metaKey || mouseEvent.ctrlKey) && editorView) {
      event.preventDefault();
      event.stopPropagation();
      const position = Number(table.dataset.from);
      rawTableFrom = position;
      editorView.focus();
      editorView.dispatch({selection: {anchor: position}});
      return;
    }

  });

  document.querySelector(".editor-shell")?.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-table-action]");
    if (!action || action.dataset.tableAction !== "add-column") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    addEditableTableColumn(Number(action.dataset.tableFrom));
  });

  document.querySelector(".editor-shell")?.addEventListener("change", (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-table-from]");
    if (!input) {
      return;
    }

    applyEditableTableChange(input);
  });

  document.querySelector(".editor-shell")?.addEventListener("focusout", (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-table-from]");
    if (!input) {
      return;
    }

    applyEditableTableChange(input);
  });

  document.addEventListener("click", (event) => {
    if (voiceMenu && !(event.target as HTMLElement).closest(".voice-menu")) {
      voiceMenu = null;
      render();
    }
    if (treeMenu && !(event.target as HTMLElement).closest(".tree-menu")) {
      treeMenu = null;
      render();
    }
    if (tabMenu && !(event.target as HTMLElement).closest(".tab-menu")) {
      tabMenu = null;
      render();
    }
    if (pendingMove && !(event.target as HTMLElement).closest(".move-menu")) {
      pendingMove = null;
      render();
    }
  }, {once: true});

  document.querySelector<HTMLFormElement>(".prompt-box")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = document.querySelector<HTMLTextAreaElement>("#agent-prompt")?.value.trim() ?? "";
    if (prompt) {
      void sendAgentMessage(prompt);
    }
  });

  document.querySelector<HTMLTextAreaElement>("#agent-prompt")?.addEventListener("input", (event) => {
    chatDraft = (event.currentTarget as HTMLTextAreaElement).value;
  });

  document.querySelector<HTMLTextAreaElement>("#agent-prompt")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    (event.currentTarget as HTMLTextAreaElement | null)?.form?.requestSubmit();
  });

  document.querySelector<HTMLButtonElement>("#browse-vault")?.addEventListener("click", async () => {
    await browseForVault();
  });
}

function selectedEditorText() {
  if (!editorView) {
    return "";
  }

  return editorView.state.selection.ranges
    .map((range) => editorView?.state.doc.sliceString(range.from, range.to) ?? "")
    .join("\n")
    .trim();
}

function captureTransientUiState() {
  const prompt = document.querySelector<HTMLTextAreaElement>("#agent-prompt");
  if (prompt) {
    chatDraft = prompt.value;
  }

  const tree = document.querySelector<HTMLElement>(".tree");
  if (tree) {
    treeScrollTop = tree.scrollTop;
  }
}

function restoreTransientUiState() {
  const tree = document.querySelector<HTMLElement>(".tree");
  if (tree) {
    tree.scrollTop = treeScrollTop;
  }
}

async function sendAgentMessage(message: string) {
  if (agentIsRunning) {
    return;
  }

  persistEditorText();
  const agent = activeAgent();
  const requestFile = activeFile;
  chatDraft = "";
  pushChatMessage({
    role: "user",
    label: "You",
    content: message,
    meta: chatMode === "note" ? `Note: ${requestFile}` : `Path: ${currentVaultPath ?? "No vault"}`,
  });
  agentIsRunning = true;
  render();

  try {
    const response = await invoke<AgentRunResponse>("run_agent_headless", {
      request: {
        agent: selectedAgent,
        model: selectedModel,
        prompt: buildAgentPrompt(message, requestFile),
      },
    });
    const output = response.stdout || response.stderr || "(no output)";
    const update = parseModelUpdate(output);
    if (update) {
      const result = applyModelUpdate(requestFile, update);
      pushChatMessage({
        role: "assistant",
        label: agent.label,
        content: result.message,
        meta: `${response.model} applied ${update.position}`,
      });
    } else {
      pushChatMessage({
        role: "assistant",
        label: agent.label,
        content: output,
        meta: `${response.model} via ${response.command}`,
      });
    }
  } catch (error) {
    pushChatMessage({
      role: "assistant",
      label: agent.label,
      content: error instanceof Error ? error.message : String(error),
      meta: "Headless run failed",
    });
  } finally {
    agentIsRunning = false;
    render();
  }
}

function pushChatMessage(message: Omit<ChatMessage, "id">) {
  chatMessages = [...chatMessages, {id: nextChatMessageId, ...message}].slice(-30);
  nextChatMessageId += 1;
}

function buildAgentPrompt(message: string, requestFile = activeFile) {
  const history = chatMessages
    .slice(-8)
    .map((entry) => `${entry.label}: ${entry.content}`)
    .join("\n\n");
  const context =
    chatMode === "note"
      ? `Mode: Note
Active note: ${requestFile}

<active_note>
${noteText(requestFile)}
</active_note>

<active_note_lines>
${numberedNoteText(requestFile)}
</active_note_lines>`
      : `Mode: Path
Vault path: ${currentVaultPath ?? "No vault selected"}
Active folder: ${activeFolder}
Active file: ${activeFile}

<visible_files>
${visiblePathSummary()}
</visible_files>`;

  return `<persona>
You are an elite-level editor who helps the user with note taking, rewriting, structure, and reorganization of Markdown content.
</persona>

<instructions>
You are running inside Noted, a local Markdown note app. Use the provided context to help the user work with local Markdown notes.

Operating rules:
- In Note mode, treat the active note as the primary document.
- In Path mode, reason across the visible vault paths and ask for specific @file contents when needed.
- You may request edits by starting your response with an update control block. If you do this, the update block must be the first non-whitespace text in your response.
- To replace the full active note, respond exactly in this shape:
<update><position>replace-all</position><content>
FULL REPLACEMENT MARKDOWN
</content></update>
- To replace specific 1-based inclusive lines from <active_note_lines>, respond exactly in this shape:
<update><position>replace,33-48</position><content>
REPLACEMENT MARKDOWN FOR THOSE LINES
</content></update>
- You may also use insert-before,N, insert-after,N, and append as the <position> value.
- If you use an update block, do not include a conversational preface before it. Text after </update> is allowed as a short note to the user.
- Preserve Markdown structure, headings, links, tasks, and code fences unless the user asks you to change them.
- If a request is ambiguous, ask one concise clarification instead of guessing.
- Keep responses focused on the current note/vault context.
</instructions>

${context}

<chat_history>
${history || "No previous messages."}
</chat_history>

<user_request>
${message}
</user_request>`;
}

function visiblePathSummary() {
  return folders
    .map((folder) => {
      const files = markdownFiles(folder)
        .slice(0, 40)
        .map((file) => `  - ${file.path}`)
        .join("\n");
      return `${folder.path}\n${files || "  (empty)"}`;
    })
    .join("\n");
}

function openExternalLink(href: string) {
  const url = new URL(href, window.location.href);
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
    return;
  }

  window.open(url.href, "_blank", "noopener,noreferrer");
}

function numberedNoteText(path: string) {
  return noteText(path)
    .split("\n")
    .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
    .join("\n");
}

function parseModelUpdate(output: string): ModelUpdate | null {
  const trimmed = output.trimStart();
  if (!trimmed.startsWith("<update>")) {
    return null;
  }

  const position = trimmed.match(/<position>([\s\S]*?)<\/position>/)?.[1]?.trim();
  const content = trimmed.match(/<content>\n?([\s\S]*?)\n?<\/content>/)?.[1];
  if (!position || content === undefined) {
    return null;
  }

  return {position, content};
}

function applyModelUpdate(path: string, update: ModelUpdate) {
  const current = noteText(path);
  const next = applyModelUpdateToText(current, update);
  recordNoteUndo(path, current);
  applyNoteContent(path, next);

  return {
    message: `Applied model update to ${path} (${update.position}).`,
  };
}

function applyModelUpdateToText(current: string, update: ModelUpdate) {
  const position = update.position.trim().toLowerCase();
  if (position === "replace-all") {
    return update.content;
  }
  if (position === "append") {
    return `${current.replace(/\s*$/, "")}\n\n${update.content}`;
  }

  const lines = current.split("\n");
  const replace = position.match(/^replace,(\d+)-(\d+)$/);
  if (replace) {
    const start = Math.max(1, Number(replace[1]));
    const end = Math.max(start, Number(replace[2]));
    lines.splice(start - 1, end - start + 1, ...update.content.split("\n"));
    return lines.join("\n");
  }

  const insertBefore = position.match(/^insert-before,(\d+)$/);
  if (insertBefore) {
    const line = Math.max(1, Number(insertBefore[1]));
    lines.splice(line - 1, 0, ...update.content.split("\n"));
    return lines.join("\n");
  }

  const insertAfter = position.match(/^insert-after,(\d+)$/);
  if (insertAfter) {
    const line = Math.max(1, Number(insertAfter[1]));
    lines.splice(line, 0, ...update.content.split("\n"));
    return lines.join("\n");
  }

  throw new Error(`Unsupported update position: ${update.position}`);
}

function applyNoteContent(path: string, content: string) {
  noteTexts.set(path, content);
  dirtyFiles.add(path);

  if (path === activeFile && editorView) {
    editorView.dispatch({
      changes: {from: 0, to: editorView.state.doc.length, insert: content},
    });
    return;
  }

  scheduleSave(path, content);
}

function recordNoteUndo(path: string, snapshot: string) {
  const current = noteText(path);
  if (snapshot === current && (noteUndoStacks.get(path)?.at(-1) ?? "") === snapshot) {
    return;
  }

  const stack = noteUndoStacks.get(path) ?? [];
  if (stack.at(-1) !== snapshot) {
    stack.push(snapshot);
  }
  noteUndoStacks.set(path, stack.slice(-50));
  noteRedoStacks.set(path, []);
}

function undoNote(path: string) {
  const stack = noteUndoStacks.get(path);
  const previous = stack?.pop();
  if (previous === undefined) {
    return;
  }

  const current = noteText(path);
  const redoStack = noteRedoStacks.get(path) ?? [];
  redoStack.push(current);
  noteRedoStacks.set(path, redoStack.slice(-50));
  noteUndoStacks.set(path, stack ?? []);
  applyNoteContent(path, previous);
  setIndexSummary("Undo applied");
  render();
}

function redoNote(path: string) {
  const stack = noteRedoStacks.get(path);
  const next = stack?.pop();
  if (next === undefined) {
    return;
  }

  const current = noteText(path);
  const undoStack = noteUndoStacks.get(path) ?? [];
  undoStack.push(current);
  noteUndoStacks.set(path, undoStack.slice(-50));
  noteRedoStacks.set(path, stack ?? []);
  applyNoteContent(path, next);
  setIndexSummary("Redo applied");
  render();
}

function canUndoNote(path: string) {
  return (noteUndoStacks.get(path)?.length ?? 0) > 0;
}

function canRedoNote(path: string) {
  return (noteRedoStacks.get(path)?.length ?? 0) > 0;
}

async function commitActiveTitleRename() {
  if (!editingTitle) {
    return;
  }

  const oldPath = activeFile;
  const cleanTitle = sanitizeNoteTitle(titleDraft);
  const currentTitle = activeFileTitle(oldPath);
  editingTitle = false;
  titleDraft = "";
  if (!cleanTitle || cleanTitle === currentTitle) {
    render();
    return;
  }

  const newName = `${cleanTitle}${activeFileExtension(oldPath)}`;
  try {
    await invoke("rename_vault_path", {relativePath: oldPath, newName});
  } catch (error) {
    indexSummary = `Rename failed: ${error instanceof Error ? error.message : String(error)}`;
    render();
    return;
  }

  renameTreePathInPreview({x: 0, y: 0, kind: "file", path: oldPath}, newName);
  indexSummary = "Renamed";
  render();
}

function persistEditorText() {
  if (editorView && activeFile) {
    noteTexts.set(activeFile, editorView.state.doc.toString());
    editorView.destroy();
    editorView = null;
  }
}

function mountEditor() {
  const host = document.querySelector<HTMLElement>("#editor");
  if (!host) {
    return;
  }

  const state = EditorState.create({
    doc: noteText(activeFile),
    extensions: [
      history(),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
      livePreview(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const path = activeFile;
          const content = update.state.doc.toString();
          noteTexts.set(path, content);
          if (suppressNextSave) {
            suppressNextSave = false;
            return;
          }
          dirtyFiles.add(path);
          scheduleSave(path, content);
        }
      }),
      EditorView.theme({
        "&": {height: "100%"},
        ".cm-scroller": {
          fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace",
        },
      }),
    ],
  });

  editorView = new EditorView({state, parent: host});
}

function noteText(path: string) {
  if (!path) {
    return "";
  }

  if (!noteTexts.has(path)) {
    noteTexts.set(path, loadedFiles.has(path) ? "" : placeholderNote(path));
  }

  return noteTexts.get(path) ?? "";
}

async function loadActiveFile() {
  if (!activeFile) {
    return;
  }

  await loadFile(activeFile);
}

async function loadFile(path: string) {
  if (!currentVaultPath || !path || loadedFiles.has(path) || loadingFiles.has(path)) {
    return;
  }

  loadingFiles.add(path);
  setIndexSummary("Loading file...");
  try {
    const state = await invoke<FileContentState>("read_vault_file", {relativePath: path});
    loadedFiles.add(state.path);
    if (!dirtyFiles.has(state.path)) {
      noteTexts.set(state.path, state.content);
      if (state.path === activeFile && editorView) {
        if (editorView.state.doc.toString() !== state.content) {
          suppressNextSave = true;
          editorView.dispatch({
            changes: {from: 0, to: editorView.state.doc.length, insert: state.content},
          });
        }
      }
    } else {
      scheduleSave(state.path, noteTexts.get(state.path) ?? "");
    }
    setIndexSummary("Loaded");
  } catch (error) {
    setIndexSummary(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    loadingFiles.delete(path);
  }
}

function scheduleSave(path: string, content: string) {
  if (!currentVaultPath || !path || !loadedFiles.has(path)) {
    return;
  }

  const existingTimer = saveTimers.get(path);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }

  setIndexSummary("Saving...");
  const timer = window.setTimeout(async () => {
    saveTimers.delete(path);
    try {
      await invoke("write_vault_file", {relativePath: path, content});
      if (noteTexts.get(path) === content) {
        dirtyFiles.delete(path);
      }
      setIndexSummary("Saved");
    } catch (error) {
      setIndexSummary(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 700);

  saveTimers.set(path, timer);
}

function setIndexSummary(summary: string) {
  indexSummary = summary;
  const summaryElement = document.querySelector<HTMLElement>("#index-summary");
  if (summaryElement) {
    summaryElement.textContent = summary;
  }
}

function placeholderNote(path: string) {
  const title = path.split("/").at(-1)?.replace(/\.md$/, "") ?? "Untitled";
  return `# ${title}

Noted keeps Markdown files as the first-class surface while still allowing quick code/file review when the modifier key is held over the vault tree.

- Folder rows expand to show notes immediately.
- Hold ${navigator.platform.includes("Mac") ? "Command" : "Control"} while hovering the tree to reveal non-Markdown files.
- Agent context mode controls whether this note is attached to each request.

> Live preview renders inactive Markdown lines. Click a rendered line to edit the raw Markdown.`;
}

async function handleTreeAction(action: HTMLElement) {
  if (action.dataset.action === "delete-file" && action.dataset.fileAction) {
    await deleteFileWithConfirmation(action.dataset.fileAction);
  }
  if (action.dataset.action === "create-folder" && action.dataset.folderAction) {
    await createFolder(action.dataset.folderAction);
  }
  if (action.dataset.action === "create-file" && action.dataset.folderAction) {
    const name = action.closest(".root-folder")
      ? normalizeMarkdownName(window.prompt("File name", "Untitled.md"))
      : undefined;
    if (name === "") {
      return;
    }

    await createNewNote(action.dataset.folderAction, name);
  }
  if (action.dataset.action === "delete-folder" && action.dataset.folderAction) {
    await deleteFolderWithConfirmation(action.dataset.folderAction);
  }
}

async function handleTreeMenuAction(action: string) {
  if (!treeMenu) {
    return;
  }

  const target = treeMenu;
  treeMenu = null;

  if (action === "create-file") {
    const name = normalizeMarkdownName(window.prompt("File name", "Untitled.md"));
    if (!name) {
      render();
      return;
    }
    await createNewNote(target.path, name);
  } else if (action === "create-folder") {
    await createFolder(target.path);
  } else if (action === "rename") {
    await renameTreePath(target);
  } else if (action === "duplicate") {
    await duplicateTreePath(target);
  } else if (action === "copy" && target.kind !== "root") {
    copiedTreePath = {kind: target.kind, path: target.path};
    indexSummary = "Copied";
  } else if (action === "paste" && copiedTreePath) {
    await pasteTreePath(copiedTreePath.path, target.kind === "file" ? folderForFile(target.path) ?? "." : target.path);
  } else if (action === "delete") {
    if (target.kind === "file") {
      await deleteFileWithConfirmation(target.path);
    } else if (target.kind === "folder") {
      await deleteFolderWithConfirmation(target.path);
    }
  }

  render();
}

function handleTabMenuAction(action: string) {
  if (!tabMenu) {
    return;
  }

  const targetPath = tabMenu.path;
  tabMenu = null;
  if (action === "close") {
    closeTab(targetPath);
  } else if (action === "close-left") {
    closeTabsBeside(targetPath, "left");
  } else if (action === "close-right") {
    closeTabsBeside(targetPath, "right");
  }
}

function closeTab(path: string) {
  const closingIndex = openFiles.indexOf(path);
  openFiles = openFiles.filter((openPath) => openPath !== path);
  if (activeFile === path) {
    activeFile = openFiles[Math.max(0, closingIndex - 1)] ?? openFiles[0] ?? "";
    activeFolder = folderForFile(activeFile) ?? activeFolder;
  }
}

function closeTabsBeside(path: string, side: "left" | "right") {
  const index = openFiles.indexOf(path);
  if (index === -1) {
    return;
  }

  openFiles = side === "left" ? openFiles.slice(index) : openFiles.slice(0, index + 1);
  if (!openFiles.includes(activeFile)) {
    activeFile = path;
    activeFolder = folderForFile(activeFile) ?? activeFolder;
  }
}

async function deleteFileWithConfirmation(path: string) {
  if (!window.confirm(`Delete ${path}?`)) {
    return;
  }

  let previewOnly = false;
  try {
    await invoke("delete_vault_path", {relativePath: path, kind: "file"});
  } catch {
    previewOnly = true;
  }

  for (const folder of folders) {
    folder.files = folder.files.filter((file) => file.path !== path);
  }
  deleteCachedPath(path);
  openFiles = openFiles.filter((openPath) => openPath !== path);
  if (activeFile === path) {
    activeFile = openFiles[0] ?? folders.flatMap((folder) => folder.files)[0]?.path ?? "";
    activeFolder = folderForFile(activeFile) ?? folders[0]?.path ?? "";
  }
  indexSummary = previewOnly ? "Delete preview" : "Deleted";
  render();
}

async function deleteFolderWithConfirmation(path: string) {
  if (!window.confirm(`Delete folder ${path}?`)) {
    return;
  }

  let previewOnly = false;
  try {
    await invoke("delete_vault_path", {relativePath: path, kind: "folder"});
  } catch {
    previewOnly = true;
  }

  const index = folders.findIndex((folder) => folder.path === path);
  if (index >= 0) {
    folders.splice(index, 1);
  }
  activeFolder = folders[0]?.path ?? "";
  activeFile = folders[0]?.files[0]?.path ?? "";
  openFiles = openFiles.filter((openPath) => !openPath.startsWith(`${path}/`));
  deleteCachedPathPrefix(path);
  indexSummary = previewOnly ? "Folder delete preview" : "Folder deleted";
  expandedFolders.delete(path);
  render();
}

function requestMoveConfirmation(item: {kind: "folder" | "file"; path: string}, targetFolderPath: string, event: DragEvent) {
  const sourceFolder =
    item.kind === "file"
      ? folders.find((folder) => folder.files.some((file) => file.path === item.path))
      : folders.find((folder) => folder.path === item.path);
  const targetFolder = folders.find((folder) => folder.path === targetFolderPath);
  if (!sourceFolder || !targetFolder || sourceFolder.path === targetFolder.path) {
    return;
  }
  if (item.kind === "folder" && (targetFolder.path === item.path || targetFolder.path.startsWith(`${item.path}/`))) {
    return;
  }

  pendingMove = {
    x: event.clientX,
    y: event.clientY,
    kind: item.kind,
    sourcePath: item.path,
    targetFolderPath,
  };
  render();
}

async function moveFile(kind: "folder" | "file", path: string, targetFolderPath: string) {
  if (kind === "folder") {
    await moveFolder(path, targetFolderPath);
    return;
  }

  const sourceFolder = folders.find((folder) => folder.files.some((file) => file.path === path));
  const targetFolder = folders.find((folder) => folder.path === targetFolderPath);
  if (!sourceFolder || !targetFolder || sourceFolder.path === targetFolder.path) {
    return;
  }

  let movedFile: FileNode | null = null;
  let previewOnly = false;
  try {
    movedFile = await invoke<FileNode>("move_vault_file", {relativePath: path, targetFolder: targetFolder.path});
  } catch {
    previewOnly = true;
  }

  const file = sourceFolder.files.find((candidate) => candidate.path === path);
  if (!file) {
    return;
  }

  sourceFolder.files = sourceFolder.files.filter((candidate) => candidate.path !== path);
  const newPath = movedFile?.path ?? `${targetFolder.path === "." ? "" : `${targetFolder.path}/`}${file.name}`;
  targetFolder.files.push(movedFile ?? {...file, path: newPath});
  replaceCachedPath(path, newPath);
  openFiles = openFiles.map((openPath) => (openPath === path ? newPath : openPath));
  if (activeFile === path) {
    activeFile = newPath;
    activeFolder = targetFolder.path;
  }
  indexSummary = previewOnly ? "Move preview" : "Moved";
  render();
}

async function moveFolder(path: string, targetFolderPath: string) {
  if (path === "." || targetFolderPath === path || targetFolderPath.startsWith(`${path}/`)) {
    return;
  }

  let previewOnly = false;
  try {
    await invoke("move_vault_path", {relativePath: path, targetFolder: targetFolderPath});
    await refreshVaultTree();
  } catch {
    previewOnly = true;
    moveFolderInPreview(path, targetFolderPath);
  }

  indexSummary = previewOnly ? "Folder move preview" : "Folder moved";
  render();
}

function moveFolderInPreview(path: string, targetFolderPath: string) {
  const folder = folders.find((candidate) => candidate.path === path);
  if (!folder) {
    return;
  }

  const name = folder.name;
  const newPath = targetFolderPath === "." ? name : `${targetFolderPath}/${name}`;
  for (const candidate of folders) {
    if (candidate.path === path || candidate.path.startsWith(`${path}/`)) {
      candidate.path = `${newPath}${candidate.path.slice(path.length)}`;
    }
    for (const file of candidate.files) {
      if (file.path.startsWith(`${path}/`)) {
        file.path = `${newPath}${file.path.slice(path.length)}`;
      }
    }
  }
  folders.sort((left, right) => left.path.localeCompare(right.path));
  activeFolder = activeFolder === path || activeFolder.startsWith(`${path}/`) ? newPath : activeFolder;
  activeFile = activeFile.startsWith(`${path}/`) ? `${newPath}${activeFile.slice(path.length)}` : activeFile;
  openFiles = openFiles.map((openPath) =>
    openPath.startsWith(`${path}/`) ? `${newPath}${openPath.slice(path.length)}` : openPath,
  );
  replaceCachedPathPrefix(path, newPath);
  expandedFolders.add(targetFolderPath);
  expandedFolders.add(newPath);
}

async function createNewNote(folderPath: string, requestedName?: string) {
  const folder = folders.find((candidate) => candidate.path === folderPath);
  if (!folder) {
    return;
  }

  const name = requestedName ?? uniqueNoteName(folder);
  let note: FileNode | null = null;
  let previewOnly = false;
  try {
    note = await invoke<FileNode>("create_vault_note", {folderPath: folder.path, fileName: name});
  } catch {
    previewOnly = true;
  }

  const path = note?.path ?? `${folder.path === "." ? "" : `${folder.path}/`}${name}`;
  const content = "# Untitled\n";
  noteTexts.set(path, content);
  loadedFiles.add(path);
  folder.files.push(note ?? {name, path, kind: "markdown"});
  activeFolder = folder.path;
  expandedFolders.add(folder.path);
  activeFile = path;
  addOpenFile(path);
  indexSummary = previewOnly ? "New note preview" : "New note created";
}

async function createFolder(parentPath: string) {
  const parent = folders.find((candidate) => candidate.path === parentPath) ?? folders[0];
  if (!parent) {
    return;
  }

  const requestedName = window.prompt("Folder name", "New folder");
  const name = normalizeFolderName(requestedName);
  if (!name) {
    return;
  }

  let folder: FolderNode | null = null;
  let previewOnly = false;
  try {
    folder = await invoke<FolderNode>("create_vault_folder", {parentPath: parent.path, folderName: name});
  } catch {
    previewOnly = true;
  }

  const path = folder?.path ?? `${parent.path === "." ? "" : `${parent.path}/`}${name}`;
  folders.push(folder ?? {name, path, files: []});
  folders.sort((left, right) => left.path.localeCompare(right.path));
  activeFolder = path;
  expandedFolders.add(parent.path);
  expandedFolders.add(path);
  indexSummary = previewOnly ? "Folder create preview" : "Folder created";
}

async function renameTreePath(target: TreeMenuTarget) {
  if (target.kind === "root") {
    return;
  }

  const currentName = target.path.split("/").at(-1) ?? target.path;
  const requestedName = window.prompt("New name", currentName);
  const newName = target.kind === "file" ? normalizeFolderName(requestedName) : normalizeFolderName(requestedName);
  if (!newName || newName === currentName) {
    return;
  }

  let previewOnly = false;
  try {
    const renamed = await invoke<{path: string; itemType: "folder" | "file"}>("rename_vault_path", {
      relativePath: target.path,
      newName,
    });
    if (target.kind === "file") {
      replaceCachedPath(target.path, renamed.path);
    } else {
      replaceCachedPathPrefix(target.path, renamed.path);
    }
    await refreshVaultTree();
  } catch {
    previewOnly = true;
    renameTreePathInPreview(target, newName);
  }

  indexSummary = previewOnly ? "Rename preview" : "Renamed";
}

async function duplicateTreePath(target: TreeMenuTarget) {
  if (target.kind === "root") {
    return;
  }

  let previewOnly = false;
  try {
    await invoke("duplicate_vault_path", {relativePath: target.path});
    await refreshVaultTree();
  } catch {
    previewOnly = true;
  }

  indexSummary = previewOnly ? "Duplicate preview" : "Duplicated";
}

async function pasteTreePath(sourcePath: string, targetFolder: string) {
  let previewOnly = false;
  try {
    await invoke("paste_vault_path", {sourcePath, targetFolder});
    await refreshVaultTree();
  } catch {
    previewOnly = true;
  }

  expandedFolders.add(targetFolder);
  indexSummary = previewOnly ? "Paste preview" : "Pasted";
}

function renameTreePathInPreview(target: TreeMenuTarget, newName: string) {
  const parentPath = parentFolderPath(target.path);
  const newPath = parentPath === "." ? newName : `${parentPath}/${newName}`;

  if (target.kind === "file") {
    for (const folder of folders) {
      const file = folder.files.find((candidate) => candidate.path === target.path);
      if (file) {
        file.name = newName;
        file.path = newPath;
      }
    }
    replaceCachedPath(target.path, newPath);
    openFiles = openFiles.map((path) => (path === target.path ? newPath : path));
    if (activeFile === target.path) {
      activeFile = newPath;
    }
    return;
  }

  const folder = folders.find((candidate) => candidate.path === target.path);
  if (!folder) {
    return;
  }

  folder.name = newName;
  folder.path = newPath;
  for (const candidate of folders) {
    if (candidate.path.startsWith(`${target.path}/`)) {
      candidate.path = `${newPath}${candidate.path.slice(target.path.length)}`;
    }
    for (const file of candidate.files) {
      if (file.path.startsWith(`${target.path}/`)) {
        file.path = `${newPath}${file.path.slice(target.path.length)}`;
      }
    }
  }
  activeFolder = activeFolder === target.path ? newPath : activeFolder;
  replaceCachedPathPrefix(target.path, newPath);
}

function uniqueNoteName(folder: FolderNode) {
  let counter = 1;
  let name = "Untitled.md";
  while (folder.files.some((file) => file.name === name)) {
    counter += 1;
    name = `Untitled ${counter}.md`;
  }
  return name;
}

function addOpenFile(path: string) {
  openFiles = [path, ...openFiles.filter((openPath) => openPath !== path)].slice(0, 6);
}

function replaceCachedPath(oldPath: string, newPath: string) {
  const text = noteTexts.get(oldPath);
  if (text !== undefined) {
    noteTexts.delete(oldPath);
    noteTexts.set(newPath, text);
  }

  transferSetPath(loadedFiles, oldPath, newPath);
  transferSetPath(loadingFiles, oldPath, newPath);
  transferSetPath(dirtyFiles, oldPath, newPath);
  transferMapPath(noteUndoStacks, oldPath, newPath);
  transferMapPath(noteRedoStacks, oldPath, newPath);
  const timer = saveTimers.get(oldPath);
  if (timer) {
    window.clearTimeout(timer);
    saveTimers.delete(oldPath);
  }
}

function replaceCachedPathPrefix(oldPrefix: string, newPrefix: string) {
  for (const path of Array.from(noteTexts.keys())) {
    if (path === oldPrefix || path.startsWith(`${oldPrefix}/`)) {
      replaceCachedPath(path, `${newPrefix}${path.slice(oldPrefix.length)}`);
    }
  }
}

function deleteCachedPath(path: string) {
  noteTexts.delete(path);
  loadedFiles.delete(path);
  loadingFiles.delete(path);
  dirtyFiles.delete(path);
  noteUndoStacks.delete(path);
  noteRedoStacks.delete(path);
  const timer = saveTimers.get(path);
  if (timer) {
    window.clearTimeout(timer);
    saveTimers.delete(path);
  }
}

function deleteCachedPathPrefix(prefix: string) {
  for (const path of Array.from(noteTexts.keys())) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      deleteCachedPath(path);
    }
  }
}

function transferSetPath(paths: Set<string>, oldPath: string, newPath: string) {
  if (paths.delete(oldPath)) {
    paths.add(newPath);
  }
}

function transferMapPath<T>(paths: Map<string, T>, oldPath: string, newPath: string) {
  const value = paths.get(oldPath);
  if (value !== undefined) {
    paths.delete(oldPath);
    paths.set(newPath, value);
  }
}

function folderForFile(path: string) {
  return folders.find((folder) => folder.files.some((file) => file.path === path))?.path;
}

function activeFileTitle(path = activeFile) {
  const name = path.split("/").at(-1) ?? "Untitled";
  return name.replace(/\.[^.]+$/, "");
}

function activeFileExtension(path = activeFile) {
  const name = path.split("/").at(-1) ?? "";
  const match = name.match(/(\.[^.]+)$/);
  return match?.[1] ?? ".md";
}

function vaultRootName() {
  if (!currentVaultPath) {
    return "Vault root";
  }

  return currentVaultPath.split(/[\\/]/).filter(Boolean).at(-1) ?? currentVaultPath;
}

function parentFolderPath(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function folderDepth(path: string) {
  if (path === ".") {
    return 0;
  }

  return Math.max(0, path.split("/").filter(Boolean).length - 1);
}

function openTreeMenu(event: MouseEvent, kind: TreeMenuTarget["kind"], path: string) {
  treeMenu = {
    x: event.clientX,
    y: event.clientY,
    kind,
    path,
  };
}

function toggleFolder(path: string) {
  if (expandedFolders.has(path)) {
    expandedFolders.delete(path);
    return;
  }

  expandedFolders.add(path);
}

function expandAllFolders() {
  expandedFolders = new Set(folders.map((folder) => folder.path));
}

function normalizeFolderName(name: string | null) {
  return name?.trim().replace(/[\\/]/g, "-") ?? "";
}

function normalizeMarkdownName(name: string | null) {
  const cleaned = normalizeFolderName(name);
  if (!cleaned) {
    return "";
  }

  return /\.(md|markdown)$/i.test(cleaned) ? cleaned : `${cleaned}.md`;
}

function sanitizeNoteTitle(value: string) {
  return value
    .replace(/[^A-Za-z0-9 _-]/g, "-")
    .replace(/[ ]{2,}/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_ ]+|[-_ ]+$/g, "");
}

function updateAllFilesReveal(nextValue: boolean) {
  if (showAllFiles !== nextValue) {
    showAllFiles = nextValue;
    render();
  }
}

async function detectAgents() {
  try {
    const detected = await invoke<DetectedCommand[]>("detect_agent_commands");
    for (const agent of agentOptions) {
      agent.available = detected.some(
        (command) => command.command === agent.command && command.available,
      );
    }
  } catch {
    agentOptions[0].available = true;
  }

  const firstAvailable = agentOptions.find((agent) => agent.available) ?? agentOptions[0];
  selectedAgent = firstAvailable.id;
  selectedModel = firstAvailable.defaultModel;
  render();
}

async function loadVaultConfig() {
  try {
    const state = await invoke<VaultConfigState>("get_vault_config");
    configPath = state.configPath;
    currentVaultPath = state.vault;
    firstRun = !state.vault;
    if (state.vault) {
      await loadVaultTree(state.vault);
    }
  } catch {
    currentVaultPath = null;
    firstRun = true;
  }

  render();
}

async function browseForVault() {
  if (isOpeningVault) {
    return;
  }

  isOpeningVault = true;
  firstRunError = null;
  indexSummary = "Opening vault...";
  render();

  let selected: string | null | string[] = null;
  try {
    selected = await open({
      directory: true,
      multiple: false,
      title: "Select your main notes folder",
    });
  } catch {
    firstRunError = await browseForVaultInBrowser();
    isOpeningVault = false;
    render();
    return;
  }

  if (typeof selected !== "string") {
    isOpeningVault = false;
    render();
    return;
  }

  try {
    const opened = await invoke<VaultOpenState>("set_vault_path", {path: selected});
    currentVaultPath = opened.vault;
    configPath = opened.configPath;
    indexSummary = `${opened.documents} files, ${opened.updated} updated`;
    await loadVaultTree(opened.vault);
    firstRun = false;
  } catch {
    firstRunError = "That folder could not be opened. Launch Noted through the desktop shell and select a local filesystem folder.";
    indexSummary = "Open failed";
  } finally {
    isOpeningVault = false;
  }

  render();
}

async function browseForVaultInBrowser() {
  const picker = window as BrowserDirectoryPicker;
  if (!picker.showDirectoryPicker) {
    return "Open the desktop app to use the operating system folder picker.";
  }

  await picker.showDirectoryPicker();
  return "Browser preview can choose a directory, but it cannot provide the full local path Noted needs. Open the desktop app to connect your notes folder.";
}

async function loadVaultTree(path?: string) {
  const nextFolders = await invoke<FolderNode[]>("list_vault_tree", {path: path ?? null});
  if (!nextFolders.length) {
    return;
  }

  folders = nextFolders;
  expandedFolders = new Set(folders.map((folder) => folder.path));
  activeFolder = folders[0]?.path ?? "";
  activeFile = folders.flatMap((folder) => markdownFiles(folder))[0]?.path ?? folders[0]?.files[0]?.path ?? "";
  openFiles = activeFile ? [activeFile] : [];
}

async function refreshVaultTree() {
  if (currentVaultPath) {
    await loadVaultTree(currentVaultPath);
  }
}

render();
loadVaultConfig();
detectAgents();

window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if ((event.metaKey || event.ctrlKey) && !target?.closest(".cm-editor, #agent-prompt")) {
    const key = event.key.toLowerCase();
    if (key === "z" && event.shiftKey && canRedoNote(activeFile)) {
      event.preventDefault();
      redoNote(activeFile);
      return;
    }
    if (key === "z" && canUndoNote(activeFile)) {
      event.preventDefault();
      undoNote(activeFile);
      return;
    }
    if (key === "y" && canRedoNote(activeFile)) {
      event.preventDefault();
      redoNote(activeFile);
      return;
    }
  }

  if (pointerInTree && (event.metaKey || event.ctrlKey)) {
    updateAllFilesReveal(true);
  }
});

window.addEventListener("keyup", (event) => {
  if (pointerInTree && !event.metaKey && !event.ctrlKey) {
    updateAllFilesReveal(false);
  }
});
