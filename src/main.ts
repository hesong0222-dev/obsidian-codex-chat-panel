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
  setIcon
} from "obsidian";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const VIEW_TYPE_CODEX_CHAT = "codex-chat-panel-view";
const PLUGIN_ID = "codex-chat-panel";
const ASSISTANT_NAME = "Codex";
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
}

interface ActiveFileContext {
  file: TFile | null;
  path: string;
  content: string;
  selection: string;
  originalChars: number;
  clipped: boolean;
}

interface SelectionSnapshot {
  text: string;
  filePath: string;
  createdAt: number;
}

interface CodexJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

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
      this.captureSelectionSnapshot();
    });

    this.registerDomEvent(document, "mouseup", () => {
      window.setTimeout(() => this.captureSelectionSnapshot(), 0);
    });

    this.registerDomEvent(document, "keyup", () => {
      this.captureSelectionSnapshot();
    });

    this.addSettingTab(new CodexChatSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      void this.activateView({ focusComposer: false });
    });
  }

  onunload(): void {
    this.currentView?.cancelCodex();
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
    const editorSelection = this.getEditorSelectionForFile(file).trim();
    if (editorSelection) {
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

  private captureSelectionSnapshot(): void {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!selection || !text) {
      return;
    }

    const anchorEl = nodeToElement(selection.anchorNode);
    if (anchorEl?.closest(".codex-chat-root")) {
      return;
    }

    const file = this.getActiveFileForContext();
    if (!file) {
      return;
    }

    this.lastActiveFile = file;
    this.selectionSnapshot = {
      text,
      filePath: file.path,
      createdAt: Date.now()
    };
    this.currentView?.setSelectionPreview(file.path, text);
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

    this.activeContext = {
      file,
      path: file.path,
      content: clipped.text,
      selection,
      originalChars: rawContent.length,
      clipped: clipped.clipped
    };

    this.renderContext();
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

    return [
      "You are Codex running inside an Obsidian side panel.",
      languageInstruction,
      "Use the active file context as the primary source. If the context is insufficient, say what is missing.",
      "Be direct and practical. Do not claim to have edited files unless the user explicitly asks for edits and you actually make them.",
      "For code or study material, point to the specific function, concept, line pattern, or section when useful.",
      "",
      `Vault root: ${this.plugin.getVaultBasePath()}`,
      "",
      activeFileBlock,
      "",
      selectionBlock,
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
    if (this.statusEl) {
      this.statusEl.setText(value ? "typing" : "ready");
      this.statusEl.toggleClass("is-busy", value);
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
    selection: "",
    originalChars: 0,
    clipped: false
  };
}

function nodeToElement(node: Node | null): Element | null {
  if (!node) {
    return null;
  }

  return node instanceof Element ? node : node.parentElement;
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
