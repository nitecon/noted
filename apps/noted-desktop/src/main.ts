import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-dialog";
import {defaultKeymap, history, historyKeymap} from "@codemirror/commands";
import {markdown} from "@codemirror/lang-markdown";
import {defaultHighlightStyle, syntaxHighlighting} from "@codemirror/language";
import {EditorState, RangeSetBuilder, StateEffect, type Extension} from "@codemirror/state";
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
    models: ["gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"],
    defaultModel: "gpt-5.3-codex",
    available: false,
  },
  {
    id: "gemini",
    label: "Gemini",
    command: "gemini",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    defaultModel: "gemini-2.5-pro",
    available: false,
  },
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    models: ["opus", "sonnet", "haiku"],
    defaultModel: "sonnet",
    available: false,
  },
];

let showAllFiles = false;
let activeFolder = "Inbox";
let activeFile = "Inbox/Project overview.md";
let openFiles = ["Inbox/Project overview.md", "Noted/Desktop shell.md"];
let selectedAgent: AgentId = "codex";
let selectedModel = "gpt-5.3-codex";
let chatMode: ChatMode = "note";
let pointerInTree = false;
let expandedFolders = new Set(folders.map((folder) => folder.path));
let currentVaultPath: string | null = null;
let configPath = "~/.noted/config.yml";
let firstRun = false;
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
            <p class="note-location">${activeFile}</p>
            <h2>${activeFile.split("/").at(-1)?.replace(/\.md$/, "") ?? "Untitled"}</h2>
          </div>
          <div class="sync-state" aria-label="Document status">
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
        <section class="chat-thread" aria-label="Chat placeholder">
          <article class="message assistant">
            <span class="message-label">${agent.label}</span>
            <p>${agent.available ? "Command detected in PATH." : "Command not detected yet."} ${
              listenMode
                ? `Voice-to-text will send to ${agent.label} using ${selectedModel} after a 5 second pause.`
                : chatMode === "note"
                  ? "The active note will be attached to each request."
                : "Use @file mentions and tool words like search, list, outline, or section."
            }</p>
          </article>
          <article class="message user">
            <span class="message-label">You</span>
            <p>${chatMode === "note" ? "Help revise the current note." : "Search @Research for vector notes."}</p>
          </article>
        </section>

        ${renderChatInput(agent)}
      </aside>
    </main>
  `;

  bindEvents();
  mountEditor();
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

class LivePreviewPlugin implements PluginValue {
  decorations: DecorationSet;
  private idleTimer: number | undefined;

  constructor(private readonly view: EditorView) {
    this.decorations = buildLivePreviewDecorations(view);
    this.scheduleIdleRefresh();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildLivePreviewDecorations(update.view);
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
      this.scheduleIdleRefresh();
    }, idleRenderDelayMs);
  }
}

const forceDecorationRefresh = StateEffect.define<null>();

function livePreview(): Extension {
  return ViewPlugin.fromClass(LivePreviewPlugin, {
    decorations: (plugin) => plugin.decorations,
  });
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
            inclusive: false,
          }),
        );
      }

      if (line.to >= to || line.to === view.state.doc.length) break;
      pos = line.to + 1;
    }
  }

  return builder.finish();
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
      }"></textarea>
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
        <button type="submit">Send</button>
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
        <button type="button" id="browse-vault">Browse</button>
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

function folderForFile(path: string) {
  return folders.find((folder) => folder.files.some((file) => file.path === path))?.path;
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
  let selected: string | null | string[] = null;
  try {
    selected = await open({
      directory: true,
      multiple: false,
      title: "Select your main notes folder",
    });
  } catch {
    selected = await browseForVaultInBrowser();
  }

  if (typeof selected !== "string") {
    return;
  }

  try {
    const opened = await invoke<VaultOpenState>("set_vault_path", {path: selected});
    currentVaultPath = opened.vault;
    configPath = opened.configPath;
    indexSummary = `${opened.documents} files, ${opened.updated} updated`;
    await loadVaultTree(opened.vault);
  } catch {
    currentVaultPath = selected;
    indexSummary = "Browser preview";
  }

  firstRun = false;
  render();
}

async function browseForVaultInBrowser() {
  const picker = window as BrowserDirectoryPicker;
  if (!picker.showDirectoryPicker) {
    firstRunError = "Open the desktop app to use the operating system folder picker.";
    render();
    return null;
  }

  const directory = await picker.showDirectoryPicker();
  return directory.name;
}

async function loadVaultTree(path: string) {
  const nextFolders = await invoke<FolderNode[]>("list_vault_tree", {path});
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
  if (pointerInTree && (event.metaKey || event.ctrlKey)) {
    updateAllFilesReveal(true);
  }
});

window.addEventListener("keyup", (event) => {
  if (pointerInTree && !event.metaKey && !event.ctrlKey) {
    updateAllFilesReveal(false);
  }
});
