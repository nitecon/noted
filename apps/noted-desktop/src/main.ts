import "./styles.css";

type Note = {
  title: string;
  path: string;
  excerpt: string;
  updated: string;
};

const notes: Note[] = [
  {
    title: "Project overview",
    path: "Inbox/Project overview.md",
    excerpt: "CLI-first notes, search, outlines, and agent-friendly editing.",
    updated: "Today",
  },
  {
    title: "Desktop shell",
    path: "Noted/Desktop shell.md",
    excerpt: "Tauri app layout with vault navigation, editor, and agent pane.",
    updated: "Yesterday",
  },
  {
    title: "Search experiments",
    path: "Research/Search experiments.md",
    excerpt: "Placeholder results until the desktop app connects to noted-core.",
    updated: "Apr 20",
  },
];

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

app.innerHTML = `
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

      <section class="vault-section" aria-labelledby="vault-tree-heading">
        <h2 id="vault-tree-heading">Folders</h2>
        <nav class="tree">
          <button type="button" class="tree-item active">Inbox</button>
          <button type="button" class="tree-item">Noted</button>
          <button type="button" class="tree-item">Research</button>
          <button type="button" class="tree-item">Archive</button>
        </nav>
      </section>

      <section class="vault-section" aria-labelledby="recent-notes-heading">
        <h2 id="recent-notes-heading">Recent notes</h2>
        <div class="note-list">
          ${notes
            .map(
              (note) => `
                <button class="note-row" type="button">
                  <span class="note-title">${note.title}</span>
                  <span class="note-path">${note.path}</span>
                  <span class="note-excerpt">${note.excerpt}</span>
                  <span class="note-updated">${note.updated}</span>
                </button>
              `,
            )
            .join("")}
        </div>
      </section>
    </aside>

    <section class="editor-pane" aria-label="Markdown editor">
      <header class="editor-toolbar">
        <div>
          <p class="note-location">Inbox / Project overview.md</p>
          <h2>Project overview</h2>
        </div>
        <div class="toolbar-actions" aria-label="Editor actions">
          <button type="button">Preview</button>
          <button type="button">Sync</button>
        </div>
      </header>

      <div class="editor-shell">
        <textarea aria-label="Editor placeholder" spellcheck="true"># Project overview

Noted is a Markdown workspace built for fast local navigation and agent-assisted editing.

- Vault tree, search, and recent notes are scaffolded in the desktop shell.
- This editor is a placeholder for the CodeMirror live-preview integration.
- The right pane will host agent workflows and note-aware chat.
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

      <div class="tabs" role="tablist" aria-label="Agent panel tabs">
        <button type="button" class="tab active" role="tab" aria-selected="true">Chat</button>
        <button type="button" class="tab" role="tab" aria-selected="false">Outline</button>
        <button type="button" class="tab" role="tab" aria-selected="false">Tasks</button>
      </div>

      <section class="chat-thread" aria-label="Chat placeholder">
        <article class="message assistant">
          <span class="message-label">Agent</span>
          <p>Select a note or ask for a vault-aware action once the backend bridge is connected.</p>
        </article>
        <article class="message user">
          <span class="message-label">You</span>
          <p>Summarize the active note and suggest follow-up edits.</p>
        </article>
      </section>

      <form class="prompt-box">
        <label class="sr-only" for="agent-prompt">Message agent</label>
        <textarea id="agent-prompt" rows="3" placeholder="Ask about this note"></textarea>
        <button type="submit">Send</button>
      </form>
    </aside>
  </main>
`;

document.querySelector<HTMLFormElement>(".prompt-box")?.addEventListener("submit", (event) => {
  event.preventDefault();
});
