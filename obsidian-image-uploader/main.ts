import { Plugin, MarkdownView, Notice, Platform, TFile, TAbstractFile, Menu, Editor, MenuItem } from 'obsidian';
import { PluginSettings, migrateSettings, settingsEqual } from './src/types';
import { QiniuUploaderSettingTab } from './src/settings';
import { ImageHandler } from './src/imageHandler';
import { initBuiltinProviders, listProviders } from './src/providers';
import { isImageExt, getErrorMessage } from './src/utils';

export default class QiniuImageUploaderPlugin extends Plugin {
  settings!: PluginSettings;
  private imageHandler!: ImageHandler;

  async onload() {
    // 注册内置 provider（必须在 loadSettings 之前，迁移逻辑会用到 provider 默认值）
    initBuiltinProviders();

    // 加载设置
    await this.loadSettings();

    // 初始化图片处理器
    this.imageHandler = new ImageHandler(this);

    // 注册粘贴事件监听器
    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt, editor, view) => {
        if (view instanceof MarkdownView) {
          this.imageHandler.handlePaste(evt, editor, view);
        }
      })
    );

    // 注册拖放事件监听器
    this.registerEvent(
      this.app.workspace.on('editor-drop', (evt, editor, view) => {
        if (view instanceof MarkdownView) {
          this.imageHandler.handleDrop(evt, editor, view);
        }
      })
    );

    // 编辑器右键菜单：当光标处是本地图片 markdown 链接时，显示「上传到图床」
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        const cursor = editor.getCursor();
        const matched = this.imageHandler.findLocalImageAtCursor(editor, cursor);
        if (!matched) return;
        menu.addItem((item: MenuItem) => {
          item
            .setTitle('上传到图床')
            .setIcon('image-up')
            .onClick(() => {
              this.imageHandler.uploadLocalFromEditor(editor, view, matched);
            });
        });
      })
    );

    // 文件浏览器右键菜单：当目标是图片文件时，显示「上传到图床」
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!isImageExt(file.extension)) return;
        menu.addItem((item: MenuItem) => {
          item
            .setTitle('上传到图床')
            .setIcon('image-up')
            .onClick(() => {
              this.imageHandler.uploadLocalFromVault(file);
            });
        });
      })
    );

    // 添加设置面板
    this.addSettingTab(new QiniuUploaderSettingTab(this.app, this));

    // 添加命令：手动上传剪贴板图片
    this.addCommand({
      id: 'upload-clipboard-image',
      name: '上传剪贴板图片',
      callback: async () => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
          new Notice('请先打开一个 Markdown 文件');
          return;
        }

        // Clipboard API 在移动端 / 部分浏览器环境不可用
        if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
          new Notice(
            Platform.isMobile
              ? '移动端不支持读取剪贴板图片，请使用粘贴方式'
              : '当前环境不支持 Clipboard API，请直接粘贴图片'
          );
          return;
        }

        try {
          const clipboardItems = await navigator.clipboard.read();
          for (const item of clipboardItems) {
            const imageTypes = item.types.filter(t => t.startsWith('image/'));
            if (imageTypes.length > 0) {
              const blob = await item.getType(imageTypes[0]);
              const ext = imageTypes[0].split('/')[1] || 'png';
              const file = new File([blob], `clipboard-image.${ext}`, { type: imageTypes[0] });
              await this.imageHandler.uploadAndInsert(file, activeView.editor, file.name);
              return;
            }
          }
          new Notice('剪贴板中没有图片');
        } catch (error) {
          new Notice(`读取剪贴板失败: ${getErrorMessage(error)}`);
          console.error('[ImageUploader] Clipboard 读取失败:', error);
        }
      },
    });
  }

  onunload() {
    // 清理所有 provider 内部缓存（如 token），避免敏感数据驻留内存
    for (const p of listProviders()) {
      p.clearCache?.();
    }
  }

  async loadSettings() {
    const raw = await this.loadData();
    this.settings = migrateSettings(raw);
    // 仅当结构发生变化（迁移真正发生 / 字段补齐）时才回写磁盘，
    // 避免每次启动都产生无意义写入
    if (!settingsEqual(raw, this.settings)) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
