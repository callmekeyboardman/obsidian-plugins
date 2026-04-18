import {
  App,
  FileView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

/**
 * Default extensions that Obsidian doesn't natively support but are common
 * attachments people want to see in the file explorer.
 */
const DEFAULT_EXTENSIONS = [
  // Office
  "xlsx", "xls", "xlsm", "csv",
  "docx", "doc",
  "pptx", "ppt",
  // Archives
  "zip", "rar", "7z", "tar", "gz",
  // Executables / installers
  "exe", "msi", "dmg", "apk", "app",
  // Other documents
  "epub", "mobi", "rtf", "odt", "ods", "odp",
  // Misc data
  "psd", "ai", "sketch", "fig",
  "iso", "torrent",
];

interface ExternalFileViewSettings {
  /** Extra extensions to register (comma separated, no dot). */
  extraExtensions: string;
  /** Whether to disable the default extensions and only use extra extensions. */
  disableDefaults: boolean;
}

const DEFAULT_SETTINGS: ExternalFileViewSettings = {
  extraExtensions: "",
  disableDefaults: false,
};

export const VIEW_TYPE_EXTERNAL_FILE = "all-file-viewer";

export default class ExternalFileViewPlugin extends Plugin {
  settings!: ExternalFileViewSettings;
  /** Registered extensions, kept so we can unregister cleanly on settings change. */
  private registeredExtensions: string[] = [];

  async onload() {
    await this.loadSettings();

    // Register the FileView. Obsidian will instantiate it for any file whose
    // extension is registered via `registerExtensions(..., VIEW_TYPE_EXTERNAL_FILE)`.
    this.registerView(
      VIEW_TYPE_EXTERNAL_FILE,
      (leaf) => new ExternalFileView(leaf, this)
    );

    this.applyExtensionRegistrations();

    // Right-click menu in file explorer: "Open with default app" / "Show in system explorer"
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        if (!this.shouldHandle(file.extension)) return;

        menu.addItem((item) =>
          item
            .setTitle("Open with default app")
            .setIcon("lucide-external-link")
            .onClick(() => this.openExternally(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("Show in system explorer")
            .setIcon("lucide-folder-open")
            .onClick(() => this.showInExplorer(file))
        );
      })
    );

    // Settings tab
    this.addSettingTab(new ExternalFileViewSettingTab(this.app, this));

    // Useful command for the active external file (or active file).
    this.addCommand({
      id: "open-current-file-externally",
      name: "Open current file with default app",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        this.openExternally(file);
      },
    });
  }

  onunload() {
    // Obsidian will automatically detach views and unregister extensions
    // for this plugin when it is disabled, but we explicitly unregister
    // to be safe across hot-reload during development.
    if (this.registeredExtensions.length > 0) {
      try {
        (this.app as any).viewRegistry.unregisterExtensions(
          this.registeredExtensions
        );
      } catch (e) {
        // ignore — internal API may change
      }
      this.registeredExtensions = [];
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyExtensionRegistrations();
  }

  /** Compute the final list of extensions to register and (re)register them. */
  applyExtensionRegistrations() {
    // Unregister anything we previously registered.
    if (this.registeredExtensions.length > 0) {
      try {
        (this.app as any).viewRegistry.unregisterExtensions(
          this.registeredExtensions
        );
      } catch (e) {
        // ignore
      }
      this.registeredExtensions = [];
    }

    const allExts = this.computeExtensions();

    // Filter out anything Obsidian (or another plugin) already handles, otherwise
    // registerExtensions would override the native viewer and break, e.g. images.
    const reg = (this.app as any).viewRegistry;
    const safe = allExts.filter((ext) => !reg.typeByExtension[ext]);

    if (safe.length > 0) {
      this.registerExtensions(safe, VIEW_TYPE_EXTERNAL_FILE);
      this.registeredExtensions = safe;
    }
  }

  computeExtensions(): string[] {
    const set = new Set<string>();
    if (!this.settings.disableDefaults) {
      for (const ext of DEFAULT_EXTENSIONS) set.add(ext.toLowerCase());
    }
    for (const ext of this.settings.extraExtensions.split(",")) {
      const t = ext.trim().toLowerCase().replace(/^\./, "");
      if (t) set.add(t);
    }
    return Array.from(set);
  }

  /** What extensions are actually live in the view registry right now. */
  getRegisteredExtensions(): string[] {
    return [...this.registeredExtensions];
  }

  shouldHandle(extension: string): boolean {
    const ext = extension.toLowerCase();
    return this.registeredExtensions.includes(ext);
  }

  /** Open the given file with the OS default application. */
  async openExternally(file: TFile) {
    const adapter: any = this.app.vault.adapter;
    let fullPath: string | undefined;
    try {
      // FileSystemAdapter exposes getFullPath; check defensively for mobile.
      fullPath = adapter.getFullPath ? adapter.getFullPath(file.path) : undefined;
      if (!fullPath) {
        new Notice("Cannot resolve file path on this platform.");
        return;
      }
    } catch (e) {
      console.error("[external-file-view] resolve path failed", e);
      new Notice("Failed to resolve file path. See console for details.");
      return;
    }

    // Prefer Obsidian's built-in helper when available, but fall back to
    // electron's shell if it throws or is missing — we cannot trust internal
    // APIs to remain stable.
    const appAny = this.app as any;
    if (typeof appAny.openWithDefaultApp === "function") {
      try {
        await appAny.openWithDefaultApp(file.path);
        return;
      } catch (e) {
        console.warn(
          "[external-file-view] openWithDefaultApp failed, falling back to shell",
          e
        );
      }
    }

    try {
      const { shell } = require("electron");
      const error = await shell.openPath(fullPath);
      if (error) {
        new Notice(`Failed to open file: ${error}`);
      }
    } catch (e) {
      console.error("[external-file-view] shell.openPath failed", e);
      new Notice("Failed to open file. See console for details.");
    }
  }

  /** Reveal the file in the system file manager. */
  async showInExplorer(file: TFile) {
    const adapter: any = this.app.vault.adapter;
    let fullPath: string | undefined;
    try {
      fullPath = adapter.getFullPath ? adapter.getFullPath(file.path) : undefined;
      if (!fullPath) {
        new Notice("Cannot resolve file path on this platform.");
        return;
      }
    } catch (e) {
      console.error("[external-file-view] resolve path failed", e);
      new Notice("Failed to resolve file path. See console for details.");
      return;
    }

    const appAny = this.app as any;
    if (typeof appAny.showInFolder === "function") {
      try {
        appAny.showInFolder(file.path);
        return;
      } catch (e) {
        console.warn(
          "[external-file-view] showInFolder failed, falling back to shell",
          e
        );
      }
    }

    try {
      const { shell } = require("electron");
      shell.showItemInFolder(fullPath);
    } catch (e) {
      console.error("[external-file-view] shell.showItemInFolder failed", e);
      new Notice("Failed to reveal file. See console for details.");
    }
  }
}

/**
 * The view that gets opened when a registered external file is clicked.
 *
 * It optionally auto-opens the file with the system default app, and always
 * shows a small placeholder UI with manual buttons so the user keeps control
 * (e.g. when "auto open" is disabled, or when they close the external app and
 * come back to Obsidian).
 */
class ExternalFileView extends FileView {
  plugin: ExternalFileViewPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: ExternalFileViewPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.allowNoFile = false;
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE_EXTERNAL_FILE;
  }

  getIcon(): string {
    return "lucide-file";
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "External file";
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.render(file);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.contentEl.empty();
  }

  onPaneMenu(menu: Menu, _source: string): void {
    super.onPaneMenu(menu, _source);
    const file = this.file;
    if (!file) return;
    menu.addItem((item) =>
      item
        .setTitle("Open with default app")
        .setIcon("lucide-external-link")
        .onClick(() => this.plugin.openExternally(file))
    );
    menu.addItem((item) =>
      item
        .setTitle("Show in system explorer")
        .setIcon("lucide-folder-open")
        .onClick(() => this.plugin.showInExplorer(file))
    );
  }

  private render(file: TFile) {
    const root = this.contentEl;
    root.empty();
    root.addClass("external-file-view");

    const container = root.createDiv({ cls: "external-file-view__container" });

    const iconEl = container.createDiv({ cls: "external-file-view__icon" });
    setIcon(iconEl, iconForExtension(file.extension));

    container.createEl("h2", {
      cls: "external-file-view__title",
      text: file.name,
    });

    container.createEl("p", {
      cls: "external-file-view__path",
      text: file.path,
    });

    const actions = container.createDiv({ cls: "external-file-view__actions" });

    const openBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: "Open with default app",
    });
    openBtn.addEventListener("click", () => this.plugin.openExternally(file));

    const revealBtn = actions.createEl("button", {
      text: "Show in system explorer",
    });
    revealBtn.addEventListener("click", () => this.plugin.showInExplorer(file));
  }
}

/**
 * Return a Lucide icon name describing the file type. The actual visual
 * badges in the file explorer are handled via CSS in styles.css using
 * `data-path` selectors with masked SVGs; this helper is only for the big
 * icon shown inside the placeholder pane.
 */
function iconForExtension(ext: string): string {
  const e = ext.toLowerCase();
  if (["xlsx", "xls", "xlsm", "csv", "ods"].includes(e)) return "file-spreadsheet";
  if (["docx", "doc", "rtf", "odt"].includes(e)) return "file-text";
  if (["pptx", "ppt", "odp"].includes(e)) return "presentation";
  if (["zip", "rar", "7z", "tar", "gz", "iso"].includes(e)) return "archive";
  if (["exe", "msi", "dmg", "apk", "app"].includes(e)) return "app-window";
  if (["psd", "ai", "sketch", "fig"].includes(e)) return "palette";
  if (["epub", "mobi"].includes(e)) return "book-open";
  if (["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "tiff", "tif", "ico"].includes(e)) return "image";
  if (["mp4", "webm", "ogv", "mov", "mkv", "avi", "flv", "m4v", "wmv"].includes(e)) return "film";
  return "file";
}

class ExternalFileViewSettingTab extends PluginSettingTab {
  plugin: ExternalFileViewPlugin;
  private extraExtensionsTimer: number | null = null;
  private registeredListEl: HTMLElement | null = null;

  constructor(app: App, plugin: ExternalFileViewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Disable default extensions")
      .setDesc(
        "If enabled, the built-in list of common extensions (xlsx, docx, zip, ...) will not be registered. Only the extensions in the field below will be handled."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.disableDefaults).onChange(async (v) => {
          this.plugin.settings.disableDefaults = v;
          await this.plugin.saveSettings();
          this.refreshRegisteredList();
        })
      );

    new Setting(containerEl)
      .setName("Extra extensions")
      .setDesc(
        "Comma-separated list of additional extensions to display, without the leading dot. Example: dwg, sql, log"
      )
      .addTextArea((t) =>
        t
          .setPlaceholder("dwg, sql, log")
          .setValue(this.plugin.settings.extraExtensions)
          .onChange((v) => {
            // Update the in-memory value immediately so the textbox feels
            // responsive, but debounce the expensive saveSettings call which
            // re-registers all extensions.
            this.plugin.settings.extraExtensions = v;
            if (this.extraExtensionsTimer !== null) {
              window.clearTimeout(this.extraExtensionsTimer);
            }
            this.extraExtensionsTimer = window.setTimeout(async () => {
              this.extraExtensionsTimer = null;
              await this.plugin.saveSettings();
              this.refreshRegisteredList();
            }, 400);
          })
      );

    const info = containerEl.createDiv({ cls: "setting-item-description" });
    this.registeredListEl = info.createEl("p");
    info.createEl("p", {
      text:
        "Note: extensions already handled by Obsidian or another plugin (e.g. md, png, mp4) are skipped automatically.",
    });
    this.refreshRegisteredList();
  }

  hide(): void {
    if (this.extraExtensionsTimer !== null) {
      window.clearTimeout(this.extraExtensionsTimer);
      this.extraExtensionsTimer = null;
    }
  }

  private refreshRegisteredList() {
    if (!this.registeredListEl) return;
    const live = this.plugin.getRegisteredExtensions();
    this.registeredListEl.setText(
      "Currently registered extensions: " + (live.join(", ") || "(none)")
    );
  }
}
