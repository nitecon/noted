import {invoke} from "@tauri-apps/api/core";
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

const folders: FolderNode[] = [
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
let folderWell = ["Inbox", "Noted"];
let selectedAgent: AgentId = "codex";
let selectedModel = "gpt-5.3-codex";
let chatMode: ChatMode = "note";
let pointerInTree = false;

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
  const agent = activeAgent();

  root.innerHTML = `
    <main class="app-shell">
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

        <section class="folder-well" aria-label="Pinned folders">
          ${folderWell.map(renderFolderChip).join("")}
        </section>

        <section class="vault-section" aria-labelledby="vault-tree-heading">
          <div class="section-heading">
            <h2 id="vault-tree-heading">Folders</h2>
            <span>${showAllFiles ? "all files" : "markdown"}</span>
          </div>
          <nav class="tree" aria-label="Vault folders">
            ${folders.map(renderFolder).join("")}
          </nav>
        </section>
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
            <span></span>
            Live preview and save are automatic
          </div>
        </header>

        <div class="editor-shell">
          <textarea aria-label="Editor placeholder" spellcheck="true"># ${
            activeFile.split("/").at(-1)?.replace(/\.md$/, "") ?? "Untitled"
          }

Noted keeps Markdown files as the first-class surface while still allowing quick code/file review when the modifier key is held over the vault tree.

- Folder rows expand to show notes immediately.
- Hold ${navigator.platform.includes("Mac") ? "Command" : "Control"} while hovering the tree to reveal non-Markdown files.
- Agent context mode controls whether this note is attached to each request.
          </textarea>
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
              chatMode === "note"
                ? "The active note will be attached to each request."
                : "Use @file mentions and tool words like search, list, outline, or section."
            }</p>
          </article>
          <article class="message user">
            <span class="message-label">You</span>
            <p>${chatMode === "note" ? "Help revise the current note." : "Search @Research for vector notes."}</p>
          </article>
        </section>

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
      </aside>
    </main>
  `;

  bindEvents();
}

function renderFolder(folder: FolderNode) {
  const files = markdownFiles(folder);
  return `
    <div class="tree-folder" data-folder="${folder.path}">
      <button type="button" class="tree-item ${folder.path === activeFolder ? "active" : ""}">
        <span class="disclosure">▾</span>
        <span>${folder.name}</span>
        <span class="tree-count">${files.length}</span>
      </button>
      <div class="tree-children">
        ${files
          .map(
            (file) => `
              <button type="button" class="file-item ${
                file.path === activeFile ? "active" : ""
              } ${file.kind !== "markdown" ? "non-markdown" : ""}" data-file="${file.path}">
                <span>${file.name}</span>
              </button>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderFolderChip(path: string) {
  const folder = folders.find((candidate) => candidate.path === path);
  if (!folder) return "";

  return `
    <button type="button" class="folder-chip ${
      folder.path === activeFolder ? "active" : ""
    }" data-folder-chip="${folder.path}">
      ${folder.name}
    </button>
  `;
}

function renderOpenTab(path: string) {
  const fileName = path.split("/").at(-1) ?? path;
  return `
    <button type="button" class="open-tab ${
      path === activeFile ? "active" : ""
    }" data-open-file="${path}">
      <span>${fileName}</span>
      <span class="tab-path">${path.includes("/") ? path.split("/")[0] : ""}</span>
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
    const folder = (event.target as HTMLElement).closest<HTMLElement>("[data-folder]");
    const file = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-file]");

    if (file?.dataset.file) {
      activeFile = file.dataset.file;
      activeFolder = activeFile.split("/")[0] ?? activeFolder;
      addOpenFile(activeFile);
      render();
      return;
    }

    if (folder?.dataset.folder) {
      activeFolder = folder.dataset.folder;
      render();
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-folder-chip]").forEach((button) => {
    button.addEventListener("click", () => {
      activeFolder = button.dataset.folderChip ?? activeFolder;
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-open-file]").forEach((button) => {
    button.addEventListener("click", () => {
      activeFile = button.dataset.openFile ?? activeFile;
      activeFolder = activeFile.split("/")[0] ?? activeFolder;
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
      render();
    });
  });

  document.querySelector<HTMLFormElement>(".prompt-box")?.addEventListener("submit", (event) => {
    event.preventDefault();
  });
}

function addOpenFile(path: string) {
  openFiles = [path, ...openFiles.filter((openPath) => openPath !== path)].slice(0, 6);
  const folder = path.split("/")[0];
  if (folder && !folderWell.includes(folder)) {
    folderWell = [folder, ...folderWell].slice(0, 4);
  }
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

render();
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
