import {
  App,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon
} from "obsidian";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const VIEW_TYPE_CODEX_CHAT = "codex-chat-panel-view";
const PLUGIN_ID = "codex-chat-panel";
const ASSISTANT_NAME = "Codex";
const CHAT_HISTORY_FOLDER = "Codex Chat History";
const MODEL_CHOICES = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Spark" }
];

interface CodexChatSettings {
  codexPath: string;
  model: string;
  includeActiveFile: boolean;
  includeSelection: boolean;
  maxContextChars: number;
  timeoutSeconds: number;
  answerLanguage: "ko" | "en" | "auto";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  filePath?: string;
  state?: "streaming" | "error";
  statusText?: string;
  pendingEdit?: PendingEdit;
  pendingEdits?: PendingEdit[];
}

type ComposerMode = "chat" | "edit" | "agent";

interface ActiveFileContext {
  file: TFile | null;
  path: string;
  content: string;
  extraFiles: ExtraFileContext[];
  selection: string;
  originalChars: number;
  clipped: boolean;
}

interface ExtraFileContext {
  path: string;
  content: string;
  originalChars: number;
  clipped: boolean;
}

interface SelectionSnapshot {
  text: string;
  filePath: string;
  createdAt: number;
}

interface SelectionCapture {
  text: string;
  file: TFile;
  rect: DOMRect | null;
}

interface CodexJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

interface EditResult {
  operation: "replace_file" | "replace_selection";
  content: string;
  summary: string;
}

interface PendingEdit extends EditResult {
  id: string;
  file: TFile;
  filePath: string;
  baseContent: string;
  selectedText: string;
  status: "pending" | "applied" | "rejected";
}

interface DiffRow {
  type: "context" | "add" | "remove" | "skip";
  text: string;
}

interface AgentEditResult extends EditResult {
  path: string;
}

interface AgentResult {
  summary: string;
  plan: string[];
  edits: AgentEditResult[];
}

interface PreparedAgentResult {
  summary: string;
  plan: string[];
  pendingEdits: PendingEdit[];
}

interface SelectionQuickAction {
  id: string;
  label: string;
  icon: string;
  mode: ComposerMode;
  prompt: string;
}

const SELECTION_QUICK_ACTIONS: SelectionQuickAction[] = [
  {
    id: "ask",
    label: "Ask",
    icon: "message-square-text",
    mode: "chat",
    prompt: ""
  },
  {
    id: "explain",
    label: "Explain",
    icon: "circle-help",
    mode: "chat",
    prompt: "Explain the selected text clearly."
  },
  {
    id: "summarize",
    label: "Summarize",
    icon: "list",
    mode: "chat",
    prompt: "Summarize the selected text into concise bullet points."
  },
  {
    id: "rewrite",
    label: "Rewrite",
    icon: "wand-sparkles",
    mode: "edit",
    prompt: "Rewrite the selected text to be clearer while preserving its meaning."
  },
  {
    id: "quiz",
    label: "Quiz",
    icon: "file-question",
    mode: "chat",
    prompt: "Turn the selected text into a short quiz with answers."
  },
  {
    id: "checklist",
    label: "Checklist",
    icon: "list-checks",
    mode: "chat",
    prompt: "Turn the selected text into an actionable checklist."
  }
];

const DEFAULT_SETTINGS: CodexChatSettings = {
  codexPath: "codex",
  model: "gpt-5.5",
  includeActiveFile: true,
  includeSelection: true,
  maxContextChars: 24000,
  timeoutSeconds: 180,
  answerLanguage: "ko"
};

export default class CodexChatPlugin extends Plugin {
  settings: CodexChatSettings = DEFAULT_SETTINGS;
  lastActiveFile: TFile | null = null;
  currentView: CodexChatView | null = null;
  private selectionSnapshot: SelectionSnapshot | null = null;
  private selectionActionEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.lastActiveFile = this.app.workspace.getActiveFile();

    this.registerView(
      VIEW_TYPE_CODEX_CHAT,
      (leaf) => new CodexChatView(leaf, this)
    );

    this.addRibbonIcon("bot-message-square", "Open Codex chat", () => {
      void this.activateView({ focusComposer: true });
    });

    this.addCommand({
      id: "open-codex-chat-panel",
      name: "Open Codex chat panel",
      callback: () => {
        void this.activateView({ focusComposer: true });
      }
    });

    this.addCommand({
      id: "ask-codex-about-active-file",
      name: "Ask Codex about active file",
      callback: () => {
        void this.activateView({ focusComposer: true });
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile) {
          this.lastActiveFile = file;
        }
        void this.currentView?.refreshContext();
      })
    );

    this.registerDomEvent(document, "selectionchange", () => {
      this.captureSelectionSnapshot({ showAction: true });
    });

    this.registerDomEvent(document, "mouseup", () => {
      window.setTimeout(() => this.captureSelectionSnapshot({ showAction: true }), 0);
    });

    this.registerDomEvent(document, "keyup", () => {
      this.captureSelectionSnapshot({ showAction: true });
    });

    this.registerDomEvent(document, "mousedown", (event) => {
      const target = event.target as Element | null;
      if (!target?.closest(".codex-chat-selection-action")) {
        this.hideSelectionAction();
      }
    });

    this.registerDomEvent(window, "resize", () => {
      this.hideSelectionAction();
    });

    this.registerDomEvent(window, "scroll", () => {
      this.hideSelectionAction();
    });

    this.addSettingTab(new CodexChatSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      void this.activateView({ focusComposer: false });
    });
  }

  onunload(): void {
    this.currentView?.cancelCodex();
    this.removeSelectionAction();
    this.currentView = null;
  }

  async activateView(options: { focusComposer: boolean }): Promise<CodexChatView | null> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_CHAT)[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("Could not open the Codex chat panel.");
        return null;
      }
      await leaf.setViewState({
        type: VIEW_TYPE_CODEX_CHAT,
        active: true
      });
    }

    this.app.workspace.revealLeaf(leaf);

    if (leaf.view instanceof CodexChatView) {
      if (options.focusComposer) {
        leaf.view.focusComposer();
      }
      return leaf.view;
    }

    return null;
  }

  getActiveFileForContext(): TFile | null {
    return this.app.workspace.getActiveFile() ?? this.lastActiveFile;
  }

  getSelectionForContext(file: TFile): string {
    const editorSelection = this.getEditorSelectionForFile(file);
    if (editorSelection.trim()) {
      this.selectionSnapshot = {
        text: editorSelection,
        filePath: file.path,
        createdAt: Date.now()
      };
      return editorSelection;
    }

    if (this.selectionSnapshot?.filePath === file.path) {
      return this.selectionSnapshot.text;
    }

    return "";
  }

  getVaultBasePath(): string {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    return adapter.getBasePath?.() ?? process.cwd();
  }

  resolveCodexPath(): string {
    const configured = this.settings.codexPath.trim();
    if (configured && configured !== "codex") {
      return configured;
    }

    if (process.platform === "win32") {
      return configured || "codex.cmd";
    }

    const candidates = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return configured || "codex";
  }

  resolveModel(): string {
    const configured = this.settings.model.trim();
    if (MODEL_CHOICES.some((option) => option.value === configured)) {
      return configured;
    }

    return MODEL_CHOICES[0].value;
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData())
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    void this.currentView?.refreshContext();
  }

  private captureSelectionSnapshot(options: { showAction: boolean }): void {
    const capture = this.readSelectionCapture();
    if (!capture) {
      this.hideSelectionAction();
      return;
    }

    this.lastActiveFile = capture.file;
    this.selectionSnapshot = {
      text: capture.text,
      filePath: capture.file.path,
      createdAt: Date.now()
    };
    this.currentView?.setSelectionPreview(capture.file.path, capture.text);

    if (options.showAction) {
      this.showSelectionAction(capture);
    }
  }

  private readSelectionCapture(): SelectionCapture | null {
    const selection = window.getSelection();
    const text = selection?.toString() ?? "";
    const anchorEl = nodeToElement(selection?.anchorNode ?? null);
    if (anchorEl?.closest(".codex-chat-root")) {
      return null;
    }

    const file = this.getActiveFileForContext();
    if (!file) {
      return null;
    }

    if (selection && text.trim()) {
      return {
        text,
        file,
        rect: getSelectionRect(selection)
      };
    }

    const editorSelection = this.getEditorSelectionForFile(file);
    if (!editorSelection.trim()) {
      return null;
    }

    return {
      text: editorSelection,
      file,
      rect: this.getEditorSelectionRect()
    };
  }

  private getEditorSelectionRect(): DOMRect | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const rects = Array.from(
      view?.containerEl.querySelectorAll<HTMLElement>(".cm-selectionBackground") ?? []
    )
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);

    return rects.at(-1) ?? null;
  }

  private showSelectionAction(capture: SelectionCapture): void {
    if (!capture.rect) {
      return;
    }

    const button = this.ensureSelectionActionEl();
    button.dataset.filePath = capture.file.path;
    const top = Math.max(8, Math.min(window.innerHeight - 42, capture.rect.bottom + 8));
    const left = Math.max(8, Math.min(window.innerWidth - 360, capture.rect.left));
    button.style.top = `${Math.max(8, top)}px`;
    button.style.left = `${left}px`;
    button.removeClass("codex-chat-hidden");
  }

  private ensureSelectionActionEl(): HTMLElement {
    if (this.selectionActionEl) {
      return this.selectionActionEl;
    }

    const menu = document.body.createDiv({
      cls: "codex-chat-selection-action",
      attr: { "aria-label": "Codex selection actions" }
    });

    for (const action of SELECTION_QUICK_ACTIONS) {
      const button = menu.createEl("button", {
        cls: `codex-chat-selection-action-button is-${action.id}`,
        attr: {
          type: "button",
          title: action.label,
          "aria-label": action.label
        }
      });
      const icon = button.createSpan({ cls: "codex-chat-selection-action-icon" });
      setIcon(icon, action.icon);
      button.createSpan({ text: action.label, cls: "codex-chat-selection-action-label" });
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        await this.askSelectionInSideChat(action);
      });
    }

    menu.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });

    this.selectionActionEl = menu;
    return menu;
  }

  private hideSelectionAction(): void {
    this.selectionActionEl?.addClass("codex-chat-hidden");
  }

  private removeSelectionAction(): void {
    this.selectionActionEl?.remove();
    this.selectionActionEl = null;
  }

  private async askSelectionInSideChat(action: SelectionQuickAction): Promise<void> {
    const snapshot = this.selectionSnapshot;
    if (!snapshot?.text.trim()) {
      this.hideSelectionAction();
      return;
    }

    const view = await this.activateView({ focusComposer: false });
    if (!view) {
      return;
    }

    view.setSelectionPreview(snapshot.filePath, snapshot.text);
    view.prepareSelectionQuestion(action.prompt, action.mode);
    this.hideSelectionAction();
  }

  private getEditorSelectionForFile(file: TFile): string {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) {
      return "";
    }
    return view.editor.getSelection();
  }
}

class CodexChatView extends ItemView {
  private plugin: CodexChatPlugin;
  private messages: ChatMessage[] = [];
  private activeContext: ActiveFileContext = emptyContext();
  private extraContextFiles: TFile[] = [];
  private currentProcess: ChildProcessWithoutNullStreams | null = null;
  private currentTempOutput: string | null = null;
  private rootEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButtonEl!: HTMLButtonElement;
  private stopButtonEl!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelSelectEl!: HTMLSelectElement;
  private modeSelectEl!: HTMLSelectElement;
  private mode: ComposerMode = "chat";
  private busy = false;
  private cancelRequested = false;

  constructor(leaf: WorkspaceLeaf, plugin: CodexChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CODEX_CHAT;
  }

  getDisplayText(): string {
    return "Codex Chat";
  }

  getIcon(): string {
    return "bot-message-square";
  }

  async onOpen(): Promise<void> {
    this.plugin.currentView = this;
    this.renderShell();
    await this.refreshContext();
    void this.renderMessages();
  }

  async onClose(): Promise<void> {
    this.cancelCodex();
    if (this.plugin.currentView === this) {
      this.plugin.currentView = null;
    }
  }

  focusComposer(): void {
    window.setTimeout(() => this.inputEl?.focus(), 50);
  }

  prepareSelectionQuestion(prompt = "", mode: ComposerMode = "chat"): void {
    this.setMode(mode);
    if (this.inputEl) {
      this.inputEl.value = prompt;
      this.inputEl.placeholder = placeholderForMode(mode, true);
    }
    this.focusComposer();
  }

  cancelCodex(): void {
    if (this.currentProcess) {
      this.cancelRequested = true;
      this.currentProcess.kill("SIGTERM");
      this.currentProcess = null;
      this.setBusy(false);
      new Notice("Codex request stopped.");
    }
  }

  async refreshContext(): Promise<void> {
    const file = this.plugin.getActiveFileForContext();

    if (!file) {
      this.activeContext = emptyContext();
      this.renderContext();
      return;
    }

    this.plugin.lastActiveFile = file;
    const rawContent = await this.plugin.app.vault.cachedRead(file);
    const clipped = clipText(rawContent, this.plugin.settings.maxContextChars);
    const selection = this.plugin.getSelectionForContext(file);
    const extraFiles = await this.readExtraFileContexts(file);

    this.activeContext = {
      file,
      path: file.path,
      content: clipped.text,
      extraFiles,
      selection,
      originalChars: rawContent.length,
      clipped: clipped.clipped
    };

    this.renderContext();
  }

  private async readExtraFileContexts(activeFile: TFile): Promise<ExtraFileContext[]> {
    this.extraContextFiles = this.extraContextFiles.filter((file) => {
      return file.path !== activeFile.path && this.plugin.app.vault.getAbstractFileByPath(file.path) === file;
    });

    const contexts: ExtraFileContext[] = [];
    for (const file of this.extraContextFiles) {
      const rawContent = await this.plugin.app.vault.cachedRead(file);
      const clipped = clipText(rawContent, this.plugin.settings.maxContextChars);
      contexts.push({
        path: file.path,
        content: clipped.text,
        originalChars: rawContent.length,
        clipped: clipped.clipped
      });
    }
    return contexts;
  }

  setSelectionPreview(filePath: string, selection: string): void {
    if (this.activeContext.file?.path !== filePath) {
      return;
    }

    this.activeContext.selection = selection;
    this.renderContext();
  }

  private renderShell(): void {
    this.contentEl.empty();
    this.contentEl.addClass("codex-chat-content");

    this.rootEl = this.contentEl.createDiv({ cls: "codex-chat-root" });

    const header = this.rootEl.createDiv({ cls: "codex-chat-header" });
    const title = header.createDiv({ cls: "codex-chat-title" });
    const titleIcon = title.createSpan({ cls: "codex-chat-title-icon" });
    setIcon(titleIcon, "bot-message-square");
    title.createSpan({ text: "Codex", cls: "codex-chat-title-text" });
    this.statusEl = title.createSpan({ text: "ready", cls: "codex-chat-status" });

    const actions = header.createDiv({ cls: "codex-chat-actions" });
    this.makeIconButton(actions, "refresh-cw", "Refresh file context", () => {
      void this.refreshContext();
    });
    this.makeIconButton(actions, "save", "Save chat as Markdown", () => {
      void this.saveChatHistory();
    });
    this.makeIconButton(actions, "trash-2", "Clear chat", () => {
      this.messages = [];
      void this.renderMessages();
    });
    this.makeIconButton(actions, "settings", "Codex chat settings", () => {
      this.openPluginSettings();
    });

    this.contextEl = this.rootEl.createDiv({ cls: "codex-chat-context" });
    this.transcriptEl = this.rootEl.createDiv({ cls: "codex-chat-transcript" });

    const composer = this.rootEl.createDiv({ cls: "codex-chat-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "codex-chat-input",
      attr: {
        rows: "2",
        placeholder: "Ask Codex about the active file"
      }
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
        return;
      }

      event.preventDefault();
      void this.sendMessage();
    });

    const composerActions = composer.createDiv({ cls: "codex-chat-composer-actions" });
    this.renderModePicker(composerActions);
    this.renderModelPicker(composerActions);
    this.stopButtonEl = this.makeIconButton(composerActions, "square", "Stop", () => this.cancelCodex());
    this.sendButtonEl = this.makeIconButton(composerActions, "send", "Send", () => {
      void this.sendMessage();
    });
    this.setBusy(false);
  }

  private renderContext(): void {
    if (!this.contextEl) {
      return;
    }

    this.contextEl.empty();

    const fileRow = this.contextEl.createDiv({ cls: "codex-chat-context-row" });
    const filePill = fileRow.createDiv({ cls: "codex-chat-file-pill" });
    const fileIcon = filePill.createSpan({ cls: "codex-chat-file-icon" });
    setIcon(fileIcon, "file-text");

    const fileLabel = this.activeContext.file
      ? this.activeContext.path
      : "No active file";
    filePill.createSpan({ text: fileLabel, cls: "codex-chat-file-path" });

    const meta = fileRow.createDiv({ cls: "codex-chat-context-meta" });
    if (this.activeContext.file) {
      const charText = this.activeContext.clipped
        ? `${this.activeContext.content.length}/${this.activeContext.originalChars} chars`
        : `${this.activeContext.originalChars} chars`;
      meta.createSpan({ text: charText });
    }

    if (this.activeContext.selection.trim()) {
      const selectionMeta = this.contextEl.createDiv({ cls: "codex-chat-selection-preview" });
      const selectionIcon = selectionMeta.createSpan({ cls: "codex-chat-selection-icon" });
      setIcon(selectionIcon, "text-select");
      selectionMeta.createSpan({
        text: `Selected ${this.activeContext.selection.trim().length} chars`,
        cls: "codex-chat-selection-label"
      });
      selectionMeta.createSpan({
        text: clipText(this.activeContext.selection.trim(), 180).text.replace(/\s+/g, " "),
        cls: "codex-chat-selection-text"
      });
    }

    this.renderExtraContextControls();
  }

  private renderExtraContextControls(): void {
    if (!this.activeContext.file) {
      return;
    }

    const wrapper = this.contextEl.createDiv({ cls: "codex-chat-extra-context" });
    const chips = wrapper.createDiv({ cls: "codex-chat-extra-context-chips" });

    for (const extra of this.activeContext.extraFiles) {
      const chip = chips.createDiv({ cls: "codex-chat-extra-context-chip" });
      const icon = chip.createSpan({ cls: "codex-chat-extra-context-icon" });
      setIcon(icon, "file-plus-2");
      chip.createSpan({
        text: extra.path,
        cls: "codex-chat-extra-context-path"
      });
      const removeButton = chip.createEl("button", {
        cls: "codex-chat-extra-context-remove",
        attr: {
          type: "button",
          "aria-label": `Remove ${extra.path}`
        }
      });
      setIcon(removeButton, "x");
      removeButton.addEventListener("click", () => {
        this.removeExtraContextFile(extra.path);
      });
    }

    const picker = wrapper.createEl("select", {
      cls: "codex-chat-extra-context-picker",
      attr: { "aria-label": "Add context file" }
    });
    picker.createEl("option", { text: "Add context...", value: "" });
    for (const file of this.getAvailableExtraContextFiles()) {
      picker.createEl("option", {
        text: file.path,
        value: file.path
      });
    }
    picker.addEventListener("change", () => {
      if (picker.value) {
        this.addExtraContextFile(picker.value);
      }
    });
  }

  private getAvailableExtraContextFiles(): TFile[] {
    const activePath = this.activeContext.file?.path ?? "";
    const selected = new Set(this.extraContextFiles.map((file) => file.path));
    return this.plugin.app.vault.getMarkdownFiles()
      .filter((file) => file.path !== activePath && !selected.has(file.path))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 200);
  }

  private addExtraContextFile(pathValue: string): void {
    const file = this.plugin.app.vault.getAbstractFileByPath(pathValue);
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("Choose a Markdown file for context.");
      return;
    }

    if (this.extraContextFiles.some((existing) => existing.path === file.path)) {
      return;
    }

    this.extraContextFiles = [...this.extraContextFiles, file].slice(-6);
    void this.refreshContext();
  }

  private removeExtraContextFile(pathValue: string): void {
    this.extraContextFiles = this.extraContextFiles.filter((file) => file.path !== pathValue);
    void this.refreshContext();
  }

  private async renderMessages(): Promise<void> {
    if (!this.transcriptEl) {
      return;
    }

    this.transcriptEl.empty();

    if (this.messages.length === 0) {
      const empty = this.transcriptEl.createDiv({ cls: "codex-chat-empty" });
      const emptyIcon = empty.createDiv({ cls: "codex-chat-empty-icon" });
      setIcon(emptyIcon, "message-square-text");
      empty.createDiv({ text: "Codex ready", cls: "codex-chat-empty-title" });
      if (this.activeContext.file) {
        empty.createDiv({
          text: this.activeContext.path,
          cls: "codex-chat-empty-file"
        });
      }
      return;
    }

    for (const message of this.messages) {
      const item = this.transcriptEl.createDiv({
        cls: `codex-chat-message codex-chat-message-${message.role}`
      });
      const meta = item.createDiv({ cls: "codex-chat-message-meta" });
      meta.createSpan({
        text: message.role === "user" ? "You" : ASSISTANT_NAME,
        cls: "codex-chat-message-author"
      });
      if (message.filePath) {
        meta.createSpan({ text: message.filePath, cls: "codex-chat-message-file" });
      }

      if (message.role === "assistant") {
        const copy = this.makeIconButton(meta, "copy", "Copy answer", () => {
          void navigator.clipboard.writeText(message.content);
          new Notice("Copied Codex answer.");
        });
        copy.addClass("codex-chat-copy-button");
      }

      const body = item.createDiv({ cls: "codex-chat-message-body" });
      if (message.role === "assistant") {
        if (message.state === "streaming" && !message.content.trim()) {
          this.renderTypingIndicator(body, message.statusText ?? "Codex is writing");
        } else {
          body.addClass("markdown-rendered");
          await MarkdownRenderer.render(
            this.app,
            message.content,
            body,
            message.filePath ?? "",
            this
          );
          const pendingEdits = getMessagePendingEdits(message);
          if (pendingEdits.length > 0) {
            for (const edit of pendingEdits) {
              this.renderEditReview(body, message, edit);
            }
          }
          if (message.state === "streaming") {
            this.renderInlineTyping(body, message.statusText ?? "Codex is writing");
          }
        }
      } else {
        body.createDiv({
          text: message.content,
          cls: "codex-chat-user-text"
        });
      }
    }

    window.setTimeout(() => {
      this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    }, 0);
  }

  private renderEditReview(parent: HTMLElement, message: ChatMessage, edit: PendingEdit): void {
    const review = parent.createDiv({ cls: `codex-chat-edit-review is-${edit.status}` });
    const header = review.createDiv({ cls: "codex-chat-edit-review-header" });
    const title = header.createDiv({ cls: "codex-chat-edit-review-title" });
    const titleIcon = title.createSpan({ cls: "codex-chat-edit-review-icon" });
    setIcon(titleIcon, edit.operation === "replace_selection" ? "text-select" : "file-pen-line");
    title.createSpan({
      text: `${edit.operation === "replace_selection" ? "Selection edit" : "Whole note edit"}: ${edit.filePath}`
    });
    header.createSpan({
      text: edit.status,
      cls: "codex-chat-edit-review-state"
    });

    const diff = review.createDiv({ cls: "codex-chat-diff" });
    for (const row of buildDiffRows(getEditPreviewBefore(edit), getEditPreviewAfter(edit))) {
      const line = diff.createDiv({ cls: `codex-chat-diff-line is-${row.type}` });
      line.createSpan({
        text: diffPrefix(row.type),
        cls: "codex-chat-diff-prefix"
      });
      line.createSpan({
        text: row.text,
        cls: "codex-chat-diff-text"
      });
    }

    const actions = review.createDiv({ cls: "codex-chat-edit-review-actions" });
    const applyButton = actions.createEl("button", {
      text: "Apply",
      cls: "codex-chat-review-button codex-chat-review-button-primary",
      attr: { type: "button" }
    });
    const rejectButton = actions.createEl("button", {
      text: "Reject",
      cls: "codex-chat-review-button",
      attr: { type: "button" }
    });

    const disabled = edit.status !== "pending" || this.busy;
    applyButton.disabled = disabled;
    rejectButton.disabled = disabled;

    applyButton.addEventListener("click", () => {
      void this.applyPendingEdit(message, edit);
    });
    rejectButton.addEventListener("click", () => {
      this.rejectPendingEdit(message, edit);
    });
  }

  private async applyPendingEdit(message: ChatMessage, edit: PendingEdit): Promise<void> {
    if (!edit || edit.status !== "pending") {
      return;
    }

    try {
      const currentContent = await this.plugin.app.vault.read(edit.file);
      if (currentContent !== edit.baseContent) {
        throw new Error("The note changed after Codex proposed this edit. Ask Codex to regenerate the edit before applying.");
      }

      await this.applyEditResult(edit.file, edit.baseContent, edit.selectedText, edit);
      edit.status = "applied";
      if (message.pendingEdit === edit) {
        message.content = [
          `Applied edit for \`${edit.filePath}\`.`,
          "",
          edit.summary
        ].join("\n");
      }
      await this.refreshContext();
      new Notice("Codex edit applied.");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message.state = "error";
      message.content = `Could not apply Codex edit.\n\n${detail}`;
      new Notice("Could not apply Codex edit.");
    } finally {
      void this.renderMessages();
    }
  }

  private rejectPendingEdit(message: ChatMessage, edit: PendingEdit): void {
    if (!edit || edit.status !== "pending") {
      return;
    }

    edit.status = "rejected";
    if (message.pendingEdit === edit) {
      message.content = [
        `Rejected edit for \`${edit.filePath}\`.`,
        "",
        edit.summary
      ].join("\n");
    }
    void this.renderMessages();
  }

  private async saveChatHistory(): Promise<void> {
    if (this.messages.length === 0) {
      new Notice("No Codex chat to save yet.");
      return;
    }

    await this.refreshContext();
    const filePath = await this.nextChatHistoryPath();
    const markdown = this.buildChatHistoryMarkdown(filePath);
    await this.plugin.app.vault.create(filePath, markdown);
    new Notice(`Saved Codex chat to ${filePath}`);
  }

  private async nextChatHistoryPath(): Promise<string> {
    await ensureVaultFolder(this.plugin.app, CHAT_HISTORY_FOLDER);
    const now = new Date();
    const stamp = formatLocalTimestampForFile(now);
    const sourceName = this.activeContext.file
      ? this.activeContext.file.basename
      : "chat";
    const baseName = sanitizeFileName(`${stamp} ${sourceName}`);

    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      const candidate = normalizePath(`${CHAT_HISTORY_FOLDER}/${baseName}${suffix}.md`);
      if (!this.plugin.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
    }

    return normalizePath(`${CHAT_HISTORY_FOLDER}/${baseName}-${Date.now()}.md`);
  }

  private buildChatHistoryMarkdown(filePath: string): string {
    const created = new Date().toISOString();
    const sourcePath = this.activeContext.path || "";
    const selection = this.activeContext.selection.trim();
    const extraContext = this.activeContext.extraFiles;
    const body = [
      "---",
      "codex_chat: true",
      `created: ${JSON.stringify(created)}`,
      `model: ${JSON.stringify(this.plugin.resolveModel())}`,
      `source: ${JSON.stringify(sourcePath)}`,
      `message_count: ${this.messages.length}`,
      "---",
      "",
      `# Codex Chat - ${sourcePath || "Untitled"}`,
      "",
      "## Context",
      "",
      sourcePath ? `- Active note: [[${sourcePath}]]` : "- Active note: none",
      selection ? `- Selection: ${selection.length} chars` : "- Selection: none",
      extraContext.length > 0
        ? `- Extra context: ${extraContext.map((extra) => `[[${extra.path}]]`).join(", ")}`
        : "- Extra context: none",
      `- Saved file: ${filePath}`,
      "",
      selection
        ? [
          "## Selection Excerpt",
          "",
          blockquote(clipText(selection, 1200).text),
          ""
        ].join("\n")
        : "",
      "## Conversation",
      "",
      ...this.messages.map((message) => formatMessageForHistory(message))
    ];

    return body.filter((part) => part !== "").join("\n");
  }

  private async sendMessage(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.busy) {
      return;
    }

    await this.refreshContext();

    const context = this.activeContext;
    const priorMessages = this.messages.slice(-8);
    const userMessage: ChatMessage = {
      id: makeId(),
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      filePath: context.file?.path
    };
    const assistantMessage: ChatMessage = {
      id: makeId(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      filePath: context.file?.path,
      state: "streaming",
      statusText: "Codex is reading"
    };

    this.messages.push(userMessage);
    this.messages.push(assistantMessage);
    this.inputEl.value = "";
    void this.renderMessages();
    this.setBusy(true);

    try {
      if (this.mode === "edit") {
        const pendingEdit = await this.prepareEdit(text, context, assistantMessage);
        assistantMessage.pendingEdit = pendingEdit;
        assistantMessage.content = [
          `Proposed edit for \`${context.path}\`.`,
          "",
          pendingEdit.summary
        ].join("\n");
      } else if (this.mode === "agent") {
        const agentResult = await this.prepareAgent(text, context, assistantMessage);
        assistantMessage.pendingEdits = agentResult.pendingEdits;
        assistantMessage.content = formatAgentMessage(agentResult.summary, agentResult.plan, agentResult.pendingEdits.length);
      } else {
        const prompt = this.buildPrompt(text, context, priorMessages);
        const answer = await this.streamCodex(prompt, {
          onText: (partial) => {
            assistantMessage.content = partial;
            assistantMessage.statusText = "Codex is typing";
            void this.renderMessages();
          },
          onStatus: (status) => {
            assistantMessage.statusText = status;
            void this.renderMessages();
          }
        });
        assistantMessage.content = answer.trim() || "(empty response)";
      }
      assistantMessage.state = undefined;
      assistantMessage.statusText = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assistantMessage.state = "error";
      assistantMessage.statusText = undefined;
      assistantMessage.content = `Codex request failed.\n\n${message}`;
      if (!this.messages.some((chatMessage) => chatMessage.id === assistantMessage.id)) {
        this.messages.push({
          ...assistantMessage,
          state: "error",
          content: `Codex request failed.\n\n${message}`
        });
      }
      new Notice("Codex request failed.");
    } finally {
      this.setBusy(false);
      void this.renderMessages();
      this.focusComposer();
    }
  }

  private async prepareEdit(
    userText: string,
    context: ActiveFileContext,
    assistantMessage: ChatMessage
  ): Promise<PendingEdit> {
    if (!context.file) {
      throw new Error("No active note to edit.");
    }

    const fullContent = await this.plugin.app.vault.read(context.file);
    const selectedText = context.selection;
    const hasSelection = selectedText.trim().length > 0;
    if (!hasSelection && context.clipped) {
      throw new Error("This note is too large for a whole-note edit. Select a smaller section and try again.");
    }
    if (hasSelection && !fullContent.includes(selectedText)) {
      throw new Error("Could not find the selected text in the source note. Try selecting text in source mode or ask for a whole-note edit.");
    }

    assistantMessage.statusText = hasSelection ? "Codex is editing the selection" : "Codex is editing the note";
    void this.renderMessages();

    const prompt = this.buildEditPrompt(userText, context, fullContent);
    const resultText = await this.streamCodex(prompt, {
      outputSchema: buildEditOutputSchema(),
      onText: (partial) => {
        assistantMessage.content = "Preparing edit...";
        assistantMessage.statusText = "Codex is preparing changes";
        if (partial.trim()) {
          const parsed = parseEditResult(partial);
          if (parsed?.summary) {
            assistantMessage.content = parsed.summary;
          }
        }
        void this.renderMessages();
      },
      onStatus: (status) => {
        assistantMessage.statusText = status;
        void this.renderMessages();
      }
    });

    const result = parseEditResult(resultText);
    if (!result) {
      throw new Error("Codex did not return a valid edit payload.");
    }

    return {
      ...result,
      id: makeId(),
      file: context.file,
      filePath: context.path,
      baseContent: fullContent,
      selectedText,
      status: "pending"
    };
  }

  private async prepareAgent(
    userText: string,
    context: ActiveFileContext,
    assistantMessage: ChatMessage
  ): Promise<PreparedAgentResult> {
    if (!context.file) {
      throw new Error("No active note for agent mode.");
    }

    const editableFiles = await this.buildEditableFileMap(context);
    assistantMessage.statusText = "Codex is planning";
    void this.renderMessages();

    const prompt = this.buildAgentPrompt(userText, context, editableFiles);
    const resultText = await this.streamCodex(prompt, {
      outputSchema: buildAgentOutputSchema(),
      onText: (partial) => {
        assistantMessage.content = "Preparing agent plan...";
        assistantMessage.statusText = "Codex is preparing reviewed changes";
        if (partial.trim()) {
          const parsed = parseAgentResult(partial);
          if (parsed?.summary) {
            assistantMessage.content = parsed.summary;
          }
        }
        void this.renderMessages();
      },
      onStatus: (status) => {
        assistantMessage.statusText = status;
        void this.renderMessages();
      }
    });

    const result = parseAgentResult(resultText);
    if (!result) {
      throw new Error("Codex did not return a valid agent payload.");
    }

    const pendingEdits = result.edits.map((edit) => {
      const editable = editableFiles.get(edit.path);
      if (!editable) {
        throw new Error(`Agent proposed an edit outside the allowed context: ${edit.path}`);
      }
      if (edit.operation === "replace_selection" && edit.path !== context.path) {
        throw new Error("Selection edits are only allowed for the active note.");
      }
      if (edit.operation === "replace_selection" && !editable.selectedText.trim()) {
        throw new Error("Agent proposed a selection edit, but no active selection is available.");
      }
      if (edit.operation === "replace_selection" && !editable.baseContent.includes(editable.selectedText)) {
        throw new Error("Agent proposed a stale selection edit.");
      }

      return {
        operation: edit.operation,
        content: edit.content,
        summary: edit.summary,
        id: makeId(),
        file: editable.file,
        filePath: editable.file.path,
        baseContent: editable.baseContent,
        selectedText: edit.operation === "replace_selection" ? editable.selectedText : "",
        status: "pending" as const
      };
    });

    return {
      summary: result.summary,
      plan: result.plan,
      pendingEdits
    };
  }

  private async buildEditableFileMap(context: ActiveFileContext): Promise<Map<string, {
    file: TFile;
    baseContent: string;
    promptContent: string;
    selectedText: string;
  }>> {
    const files = new Map<string, {
      file: TFile;
      baseContent: string;
      promptContent: string;
      selectedText: string;
    }>();

    if (context.file) {
      const baseContent = await this.plugin.app.vault.read(context.file);
      if (baseContent.length > this.plugin.settings.maxContextChars && !context.selection.trim()) {
        throw new Error("This note is too large for whole-note Agent mode. Select a smaller section or reduce context size.");
      }
      files.set(context.file.path, {
        file: context.file,
        baseContent,
        promptContent: clipText(baseContent, this.plugin.settings.maxContextChars).text,
        selectedText: context.selection
      });
    }

    for (const extra of this.extraContextFiles) {
      if (files.has(extra.path)) {
        continue;
      }
      const rawContent = await this.plugin.app.vault.read(extra);
      if (rawContent.length > this.plugin.settings.maxContextChars) {
        continue;
      }
      files.set(extra.path, {
        file: extra,
        baseContent: rawContent,
        promptContent: rawContent,
        selectedText: ""
      });
    }

    return files;
  }

  private buildEditPrompt(userText: string, context: ActiveFileContext, fullContent: string): string {
    const selectedText = context.selection;
    const hasSelection = selectedText.trim().length > 0;
    const activeFileBlock = hasSelection
      ? context.content
      : fullContent;
    return [
      "You are editing an Obsidian Markdown note for the user.",
      "Return only JSON matching the provided schema.",
      "Do not include Markdown fences around the JSON.",
      "Preserve YAML frontmatter, wikilinks, Markdown links, code fences, headings, and surrounding structure unless the user explicitly asks to change them.",
      "If a selection is provided, use operation replace_selection and return only the replacement Markdown for that selection.",
      "If no selection is provided, use operation replace_file and return the complete updated file content.",
      "",
      `Active file path: ${context.path}`,
      "",
      `<active_file>`,
      activeFileBlock,
      `</active_file>`,
      "",
      hasSelection
        ? [
          `<selection>`,
          selectedText,
          `</selection>`
        ].join("\n")
        : "<selection omitted=\"true\" />",
      "",
      "<edit_request>",
      userText,
      "</edit_request>"
    ].join("\n");
  }

  private buildAgentPrompt(
    userText: string,
    context: ActiveFileContext,
    editableFiles: Map<string, { file: TFile; baseContent: string; promptContent: string; selectedText: string }>
  ): string {
    const editableFileBlocks = Array.from(editableFiles.values()).map((editable) => {
      const selectedText = editable.file.path === context.path ? editable.selectedText : "";
      return [
        `<editable_file path="${escapeAttribute(editable.file.path)}" selected="${selectedText.trim() ? "true" : "false"}">`,
        editable.promptContent,
        "</editable_file>",
        selectedText.trim()
          ? [
            `<selection path="${escapeAttribute(editable.file.path)}">`,
            selectedText,
            "</selection>"
          ].join("\n")
          : ""
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    return [
      "You are Codex running in safe Agent mode inside Obsidian.",
      "Return only JSON matching the provided schema.",
      "Do not include Markdown fences around the JSON.",
      "First make a concise plan. Then propose zero or more reviewed edits.",
      "You may only propose edits for files listed in <editable_files>.",
      "Do not invent file paths.",
      "Do not claim edits are applied. The user must review and apply every proposed edit.",
      "For replace_file, content must be the complete updated Markdown file.",
      "For replace_selection, use it only for the active note selection and return only replacement Markdown for that selection.",
      "Preserve YAML frontmatter, wikilinks, Markdown links, code fences, headings, and surrounding structure unless the user explicitly asks to change them.",
      "",
      `Active file path: ${context.path}`,
      "",
      "<editable_files>",
      editableFileBlocks,
      "</editable_files>",
      "",
      "<agent_request>",
      userText,
      "</agent_request>"
    ].join("\n");
  }

  private async applyEditResult(
    file: TFile,
    fullContent: string,
    selectedText: string,
    result: EditResult
  ): Promise<void> {
    if (selectedText.trim() && result.operation === "replace_file") {
      throw new Error("Codex returned a whole-note edit for a selection. Try the edit again or clear the selection for a whole-note rewrite.");
    }

    if (result.operation === "replace_selection") {
      if (!selectedText) {
        throw new Error("Codex returned a selection edit, but no selection is available.");
      }
      const index = fullContent.indexOf(selectedText);
      if (index < 0) {
        throw new Error("Could not find the selected text in the source note. Try selecting text in source mode or ask for a whole-note edit.");
      }
      const nextContent = `${fullContent.slice(0, index)}${result.content}${fullContent.slice(index + selectedText.length)}`;
      await this.plugin.app.vault.modify(file, nextContent);
      return;
    }

    await this.plugin.app.vault.modify(file, result.content);
  }

  private buildPrompt(userText: string, context: ActiveFileContext, priorMessages: ChatMessage[]): string {
    const languageInstruction = {
      ko: "Answer in Korean unless the user explicitly asks for another language.",
      en: "Answer in English unless the user explicitly asks for another language.",
      auto: "Answer in the same language as the user's latest message."
    }[this.plugin.settings.answerLanguage];

    const history = priorMessages.length > 0
      ? priorMessages.map((message) => {
        const role = message.role === "user" ? "USER" : "CODEX";
        return `${role}: ${message.content}`;
      }).join("\n\n")
      : "(none)";

    const includeFile = this.plugin.settings.includeActiveFile && context.file;
    const activeFileBlock = includeFile
      ? [
        `<active_file path="${escapeAttribute(context.path)}" clipped="${context.clipped ? "true" : "false"}">`,
        context.content,
        "</active_file>"
      ].join("\n")
      : "<active_file omitted=\"true\" />";

    const includeSelection = this.plugin.settings.includeSelection && context.selection.trim().length > 0;
    const selectionBlock = includeSelection
      ? [
        `<selection path="${escapeAttribute(context.path)}">`,
        context.selection,
        "</selection>"
      ].join("\n")
      : "<selection omitted=\"true\" />";
    const extraContextBlock = context.extraFiles.length > 0
      ? context.extraFiles.map((extraFile) => [
        `<extra_context_file path="${escapeAttribute(extraFile.path)}" clipped="${extraFile.clipped ? "true" : "false"}">`,
        extraFile.content,
        "</extra_context_file>"
      ].join("\n")).join("\n\n")
      : "<extra_context omitted=\"true\" />";

    return [
      "You are Codex running inside an Obsidian side panel.",
      languageInstruction,
      "Use the active file context as the primary source. Use extra context files only when they are relevant.",
      "Be direct and practical. Do not claim to have edited files unless the user explicitly asks for edits and you actually make them.",
      "For code or study material, point to the specific function, concept, line pattern, or section when useful.",
      "",
      `Vault root: ${this.plugin.getVaultBasePath()}`,
      "",
      activeFileBlock,
      "",
      selectionBlock,
      "",
      extraContextBlock,
      "",
      "<recent_chat>",
      history,
      "</recent_chat>",
      "",
      "<latest_user_message>",
      userText,
      "</latest_user_message>"
    ].join("\n");
  }

  private streamCodex(
    prompt: string,
    handlers: {
      onText: (text: string) => void;
      onStatus: (status: string) => void;
      outputSchema?: object;
    }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const vaultBasePath = this.plugin.getVaultBasePath();
      const codexPath = this.plugin.resolveCodexPath();
      const tempOutput = path.join(
        os.tmpdir(),
        `obsidian-codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
      );
      this.currentTempOutput = tempOutput;
      const schemaPath = handlers.outputSchema
        ? writeTempJsonFile(handlers.outputSchema)
        : null;

      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "-C",
        vaultBasePath,
        "--output-last-message",
        tempOutput,
        "-"
      ];

      args.splice(1, 0, "--model", this.plugin.resolveModel());
      if (schemaPath) {
        args.splice(args.length - 1, 0, "--output-schema", schemaPath);
      }

      const child = spawn(codexPath, args, {
        cwd: vaultBasePath,
        env: {
          ...process.env,
          NO_COLOR: "1",
          TERM: "dumb"
        },
        stdio: "pipe"
      });

      this.currentProcess = child;
      this.cancelRequested = false;
      let stdoutBuffer = "";
      let stderr = "";
      let latestAnswer = "";
      let settled = false;

      const timeout = window.setTimeout(() => {
        finish(new Error(`Timed out after ${this.plugin.settings.timeoutSeconds} seconds.`));
        child.kill("SIGTERM");
      }, this.plugin.settings.timeoutSeconds * 1000);

      const cleanup = (): void => {
        window.clearTimeout(timeout);
        if (this.currentProcess === child) {
          this.currentProcess = null;
        }
        if (schemaPath) {
          removeTempFile(schemaPath);
        }
        this.currentTempOutput = null;
      };

      const finish = (error: Error | null, output?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve(output ?? "");
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseCodexJsonEvent(line);
          if (!event) {
            continue;
          }

          const status = codexStatusFromEvent(event);
          if (status) {
            handlers.onStatus(status);
          }

          const text = codexTextFromEvent(event);
          if (text) {
            latestAnswer = text;
            handlers.onText(latestAnswer);
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        finish(error);
      });

      child.on("close", (code, signal) => {
        const event = parseCodexJsonEvent(stdoutBuffer);
        const text = event ? codexTextFromEvent(event) : "";
        if (text) {
          latestAnswer = text;
          handlers.onText(latestAnswer);
        }

        const lastMessage = readAndDeleteTempFile(tempOutput);
        if (code === 0) {
          finish(null, lastMessage || latestAnswer || normalizeCodexStdout(stdoutBuffer));
          return;
        }

        if (this.cancelRequested) {
          finish(null, latestAnswer || "Stopped.");
          return;
        }

        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        const detail = (stderr || stdoutBuffer || lastMessage || "").trim();
        finish(new Error(`Codex exited with ${reason}.${detail ? `\n\n${detail}` : ""}`));
      });

      child.stdin.end(prompt);
    });
  }

  private renderTypingIndicator(parent: HTMLElement, label: string): void {
    const typing = parent.createDiv({ cls: "codex-chat-typing" });
    typing.createSpan({ text: label, cls: "codex-chat-typing-label" });
    const dots = typing.createSpan({ cls: "codex-chat-typing-dots", attr: { "aria-hidden": "true" } });
    dots.createSpan();
    dots.createSpan();
    dots.createSpan();
  }

  private renderInlineTyping(parent: HTMLElement, label: string): void {
    const typing = parent.createDiv({ cls: "codex-chat-inline-typing" });
    typing.createSpan({ text: label });
    const dots = typing.createSpan({ cls: "codex-chat-typing-dots", attr: { "aria-hidden": "true" } });
    dots.createSpan();
    dots.createSpan();
    dots.createSpan();
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    if (this.sendButtonEl) {
      this.sendButtonEl.disabled = value;
    }
    if (this.stopButtonEl) {
      this.stopButtonEl.toggleClass("codex-chat-hidden", !value);
    }
    if (this.inputEl) {
      this.inputEl.disabled = value;
    }
    if (this.modelSelectEl) {
      this.modelSelectEl.disabled = value;
    }
    if (this.modeSelectEl) {
      this.modeSelectEl.disabled = value;
    }
    if (this.statusEl) {
      this.statusEl.setText(value ? "typing" : "ready");
      this.statusEl.toggleClass("is-busy", value);
    }
  }

  private renderModePicker(parent: HTMLElement): void {
    const wrapper = parent.createEl("label", { cls: "codex-chat-mode-picker" });
    wrapper.createSpan({ text: "Mode", cls: "codex-chat-model-label" });

    this.modeSelectEl = wrapper.createEl("select", {
      cls: "codex-chat-mode-select",
      attr: {
        "aria-label": "Codex mode"
      }
    });
    this.modeSelectEl.createEl("option", { text: "Chat", value: "chat" });
    this.modeSelectEl.createEl("option", { text: "Edit", value: "edit" });
    this.modeSelectEl.createEl("option", { text: "Agent", value: "agent" });
    this.modeSelectEl.value = this.mode;
    this.modeSelectEl.addEventListener("change", () => {
      this.setMode(parseComposerMode(this.modeSelectEl.value));
    });
  }

  private setMode(mode: ComposerMode): void {
    this.mode = mode;
    if (this.modeSelectEl) {
      this.modeSelectEl.value = mode;
    }
    if (this.inputEl) {
      this.inputEl.placeholder = placeholderForMode(mode, false);
    }
  }

  private renderModelPicker(parent: HTMLElement): void {
    const wrapper = parent.createEl("label", { cls: "codex-chat-model-picker" });
    wrapper.createSpan({ text: "Model", cls: "codex-chat-model-label" });

    this.modelSelectEl = wrapper.createEl("select", {
      cls: "codex-chat-model-select",
      attr: {
        "aria-label": "Codex model"
      }
    });

    for (const option of MODEL_CHOICES) {
      this.modelSelectEl.createEl("option", {
        text: option.label,
        value: option.value
      });
    }
    this.modelSelectEl.value = this.plugin.resolveModel();

    this.modelSelectEl.addEventListener("change", () => {
      void this.updateSelectedModelFromDropdown();
    });
  }

  private async updateSelectedModelFromDropdown(): Promise<void> {
    this.plugin.settings.model = this.modelSelectEl.value;
    await this.plugin.saveSettings();
  }

  private makeIconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "codex-chat-icon-button",
      attr: {
        "aria-label": label,
        title: label,
        type: "button"
      }
    });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
    return button;
  }

  private openPluginSettings(): void {
    const appWithSetting = this.app as App & {
      setting?: {
        open: () => void;
        openTabById: (id: string) => void;
      };
    };

    if (appWithSetting.setting) {
      appWithSetting.setting.open();
      appWithSetting.setting.openTabById(PLUGIN_ID);
      return;
    }

    new Notice("Open Settings > Community plugins > Codex Chat Panel.");
  }
}

class CodexChatSettingTab extends PluginSettingTab {
  private plugin: CodexChatPlugin;

  constructor(app: App, plugin: CodexChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Codex Chat Panel" });

    new Setting(containerEl)
      .setName("Codex CLI path")
      .setDesc("Leave as `codex` if Obsidian can find the CLI from PATH. Use an absolute path if needed.")
      .addText((text) => {
        text
          .setPlaceholder("codex")
          .setValue(this.plugin.settings.codexPath)
          .onChange(async (value) => {
            this.plugin.settings.codexPath = value.trim() || "codex";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("ChatGPT-account Codex models only.")
      .addDropdown((dropdown) => {
        for (const option of MODEL_CHOICES) {
          dropdown.addOption(option.value, option.label);
        }

        dropdown
          .setValue(this.plugin.resolveModel())
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Include active file")
      .setDesc("Send the active file as context with each message.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeActiveFile)
          .onChange(async (value) => {
            this.plugin.settings.includeActiveFile = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Include selection")
      .setDesc("Send highlighted text as focused context when available.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeSelection)
          .onChange(async (value) => {
            this.plugin.settings.includeSelection = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Max active-file context")
      .setDesc("Large files are clipped in the middle before sending to Codex.")
      .addText((text) => {
        text
          .setPlaceholder("24000")
          .setValue(String(this.plugin.settings.maxContextChars))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 2000) {
              this.plugin.settings.maxContextChars = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Timeout")
      .setDesc("Seconds before a Codex request is stopped.")
      .addText((text) => {
        text
          .setPlaceholder("180")
          .setValue(String(this.plugin.settings.timeoutSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 15) {
              this.plugin.settings.timeoutSeconds = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Answer language")
      .setDesc("Default is Korean for this vault.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("ko", "Korean")
          .addOption("en", "English")
          .addOption("auto", "Match latest message")
          .setValue(this.plugin.settings.answerLanguage)
          .onChange(async (value: "ko" | "en" | "auto") => {
            this.plugin.settings.answerLanguage = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

function emptyContext(): ActiveFileContext {
  return {
    file: null,
    path: "",
    content: "",
    extraFiles: [],
    selection: "",
    originalChars: 0,
    clipped: false
  };
}

function parseComposerMode(value: string): ComposerMode {
  if (value === "edit" || value === "agent") {
    return value;
  }
  return "chat";
}

function placeholderForMode(mode: ComposerMode, hasSelection: boolean): string {
  if (mode === "agent") {
    return hasSelection
      ? "Ask Codex to plan reviewed changes for this selection"
      : "Ask Codex to plan reviewed changes";
  }
  if (mode === "edit") {
    return hasSelection
      ? "Tell Codex how to edit the selected text"
      : "Tell Codex how to edit this note";
  }
  return hasSelection
    ? "Ask Codex about the selected text"
    : "Ask Codex about the active file";
}

function nodeToElement(node: Node | null): Element | null {
  if (!node) {
    return null;
  }

  return node instanceof Element ? node : node.parentElement;
}

function getSelectionRect(selection: Selection): DOMRect | null {
  if (selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(selection.rangeCount - 1);
  const rects = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length > 0) {
    return rects[rects.length - 1];
  }

  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clipText(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) {
    return { text, clipped: false };
  }

  const marker = "\n\n[... middle clipped for context budget ...]\n\n";
  const side = Math.max(500, Math.floor((maxChars - marker.length) / 2));
  return {
    text: `${text.slice(0, side)}${marker}${text.slice(-side)}`,
    clipped: true
  };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readAndDeleteTempFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    const text = fs.readFileSync(filePath, "utf8");
    fs.unlinkSync(filePath);
    return text;
  } catch {
    return "";
  }
}

function removeTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup.
  }
}

function writeTempJsonFile(value: object): string {
  const filePath = path.join(
    os.tmpdir(),
    `obsidian-codex-schema-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

function buildEditOutputSchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: ["replace_file", "replace_selection"]
      },
      content: {
        type: "string"
      },
      summary: {
        type: "string"
      }
    },
    required: ["operation", "content", "summary"]
  };
}

function parseEditResult(text: string): EditResult | null {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const candidate = parsed as Partial<EditResult>;
    if (
      (candidate.operation === "replace_file" || candidate.operation === "replace_selection") &&
      typeof candidate.content === "string" &&
      typeof candidate.summary === "string"
    ) {
      return {
        operation: candidate.operation,
        content: candidate.content,
        summary: candidate.summary
      };
    }
  } catch {
    return null;
  }

  return null;
}

function buildAgentOutputSchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      plan: {
        type: "array",
        items: { type: "string" }
      },
      edits: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            operation: {
              type: "string",
              enum: ["replace_file", "replace_selection"]
            },
            content: { type: "string" },
            summary: { type: "string" }
          },
          required: ["path", "operation", "content", "summary"]
        }
      }
    },
    required: ["summary", "plan", "edits"]
  };
}

function parseAgentResult(text: string): AgentResult | null {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const candidate = parsed as Partial<AgentResult>;
    if (
      typeof candidate.summary === "string" &&
      Array.isArray(candidate.plan) &&
      candidate.plan.every((item) => typeof item === "string") &&
      Array.isArray(candidate.edits) &&
      candidate.edits.every(isAgentEditResult)
    ) {
      return {
        summary: candidate.summary,
        plan: candidate.plan,
        edits: candidate.edits
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isAgentEditResult(value: unknown): value is AgentEditResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AgentEditResult>;
  return (
    typeof candidate.path === "string" &&
    (candidate.operation === "replace_file" || candidate.operation === "replace_selection") &&
    typeof candidate.content === "string" &&
    typeof candidate.summary === "string"
  );
}

function formatAgentMessage(summary: string, plan: string[], editCount: number): string {
  const lines = [
    "Agent plan prepared.",
    "",
    summary,
    "",
    "Plan:",
    ...plan.map((item, index) => `${index + 1}. ${item}`),
    "",
    editCount > 0
      ? `Review ${editCount} proposed edit${editCount === 1 ? "" : "s"} below.`
      : "No file edits were proposed."
  ];
  return lines.join("\n");
}

function getMessagePendingEdits(message: ChatMessage): PendingEdit[] {
  if (message.pendingEdits?.length) {
    return message.pendingEdits;
  }
  return message.pendingEdit ? [message.pendingEdit] : [];
}

function getEditPreviewBefore(edit: PendingEdit): string {
  return edit.operation === "replace_selection"
    ? edit.selectedText
    : edit.baseContent;
}

function getEditPreviewAfter(edit: PendingEdit): string {
  return edit.content;
}

function diffPrefix(type: DiffRow["type"]): string {
  switch (type) {
    case "add":
      return "+";
    case "remove":
      return "-";
    case "skip":
      return "...";
    default:
      return " ";
  }
}

function buildDiffRows(beforeText: string, afterText: string): DiffRow[] {
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix + prefix < before.length &&
    suffix + prefix < after.length &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const rows: DiffRow[] = [];
  const contextBefore = before.slice(Math.max(0, prefix - 3), prefix);
  if (prefix > 3) {
    rows.push({ type: "skip", text: `${prefix - 3} unchanged line${prefix - 3 === 1 ? "" : "s"}` });
  }
  rows.push(...contextBefore.map((text) => ({ type: "context" as const, text })));

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  rows.push(...removed.map((text) => ({ type: "remove" as const, text })));
  rows.push(...added.map((text) => ({ type: "add" as const, text })));

  const contextAfter = before.slice(before.length - suffix, before.length - Math.max(0, suffix - 3));
  rows.push(...contextAfter.map((text) => ({ type: "context" as const, text })));
  if (suffix > 3) {
    rows.push({ type: "skip", text: `${suffix - 3} unchanged line${suffix - 3 === 1 ? "" : "s"}` });
  }

  return clipDiffRows(rows, 160);
}

function clipDiffRows(rows: DiffRow[], maxRows: number): DiffRow[] {
  if (rows.length <= maxRows) {
    return rows;
  }

  const headCount = Math.floor((maxRows - 1) / 2);
  const tailCount = maxRows - 1 - headCount;
  return [
    ...rows.slice(0, headCount),
    { type: "skip", text: `${rows.length - headCount - tailCount} diff line${rows.length - headCount - tailCount === 1 ? "" : "s"} hidden` },
    ...rows.slice(rows.length - tailCount)
  ];
}

async function ensureVaultFolder(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  if (app.vault.getAbstractFileByPath(normalized)) {
    return;
  }
  await app.vault.createFolder(normalized);
}

function formatLocalTimestampForFile(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("-");
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "codex-chat";
}

function blockquote(value: string): string {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatMessageForHistory(message: ChatMessage): string {
  const title = message.role === "user" ? "You" : ASSISTANT_NAME;
  const parts = [
    `### ${title} - ${message.createdAt}`,
    "",
    message.content.trim() || "(empty)"
  ];

  if (message.pendingEdit) {
    parts.push(
      "",
      `Edit proposal: ${message.pendingEdit.operation}`,
      `Edit status: ${message.pendingEdit.status}`
    );
  }

  return parts.join("\n");
}

function parseCodexJsonEvent(line: string): CodexJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as CodexJsonEvent;
  } catch {
    return null;
  }
}

function codexTextFromEvent(event: CodexJsonEvent): string {
  if (event.type !== "item.completed" || event.item?.type !== "agent_message") {
    return "";
  }

  return event.item.text ?? "";
}

function codexStatusFromEvent(event: CodexJsonEvent): string {
  switch (event.type) {
    case "thread.started":
      return "Codex is connecting";
    case "turn.started":
      return "Codex is reading";
    case "item.completed":
      if (event.item?.type === "agent_message") {
        return "Codex is typing";
      }
      return "Codex is working";
    case "turn.completed":
      return "Codex is finishing";
    default:
      return "";
  }
}

function normalizeCodexStdout(stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => !line.startsWith("Codex CLI") && !line.startsWith("Usage:"))
    .join("\n")
    .trim();
}
