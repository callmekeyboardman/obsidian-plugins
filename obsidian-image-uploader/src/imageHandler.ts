import { Editor, MarkdownView, Notice, EditorPosition, TFile } from 'obsidian';
import QiniuImageUploaderPlugin from '../main';
import { getProvider, ImageUploader } from './providers';
import {
  extToMime,
  getErrorMessage,
  isRemoteLink,
  isLocalImageLink,
  isImageExt,
  createMdImageRegex,
  createWikiImageRegex,
} from './utils';

/** 命中位置/链接的统一描述 */
export interface MatchedLocalImage {
  /** 链接形式：md = ![alt](path)，wiki = ![[path|alias]] */
  kind: 'md' | 'wiki';
  alt: string;
  link: string;
  fullText: string;
  from: EditorPosition;
  to: EditorPosition;
}

/**
 * 生成全局唯一占位符 ID（优先 crypto.randomUUID，兜底 Date.now + Math.random）
 */
function genPlaceholderId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  // fallback：低熵但只要时间戳 + 随机串足以区分同会话内的并发占位符
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export class ImageHandler {
  constructor(private plugin: QiniuImageUploaderPlugin) {}

  /**
   * 解析当前生效的 provider 与配置；失败返回 null 并显示提示
   */
  private resolveActiveProvider(): { provider: ImageUploader; config: unknown } | null {
    const { activeProvider, providers } = this.plugin.settings;
    const provider = getProvider(activeProvider);
    if (!provider) {
      new Notice(`未找到图床 provider: ${activeProvider}`);
      return null;
    }
    const config = providers[activeProvider];
    if (!config) {
      new Notice(`图床 ${provider.name} 尚未配置`);
      return null;
    }
    const err = provider.validate(config);
    if (err) {
      new Notice(err);
      return null;
    }
    return { provider, config };
  }

  /**
   * 处理粘贴事件
   */
  async handlePaste(
    evt: ClipboardEvent,
    editor: Editor,
    _view: MarkdownView
  ): Promise<void> {
    if (!this.plugin.settings.enabled) return;
    if (evt.defaultPrevented) return;

    const clipboardData = evt.clipboardData;
    if (!clipboardData) return;

    const items = clipboardData.items;
    if (!items) return;

    // 收集所有图片
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length === 0) return;

    // 仅当剪贴板中明确包含「非空、非纯空白」的文本时才让 Obsidian 处理。
    // 浏览器复制图片场景下 text/html 通常是图片自身的 <img> 标签源码，
    // text/plain 则常为空 / 仅包含空白；这种情况下不应放弃图片上传。
    const text = clipboardData.getData('text/plain');
    if (text && text.trim().length > 0) return;

    // 阻止 Obsidian 默认行为（保存到本地 vault）
    evt.preventDefault();
    evt.stopPropagation();

    await this.uploadAndInsertMany(files, editor);
  }

  /**
   * 处理拖放事件
   */
  async handleDrop(
    evt: DragEvent,
    editor: Editor,
    _view: MarkdownView
  ): Promise<void> {
    if (!this.plugin.settings.enabled) return;
    if (evt.defaultPrevented) return;

    const fileList = evt.dataTransfer?.files;
    if (!fileList || fileList.length === 0) return;

    const files: File[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (file.type.startsWith('image/')) {
        files.push(file);
      }
    }

    if (files.length === 0) return;

    evt.preventDefault();
    evt.stopPropagation();

    await this.uploadAndInsertMany(files, editor);
  }

  /**
   * 在编辑器光标处插入"上传中"占位符并返回对应文本
   * 同时根据 cursor 位置自动补换行，避免与原文粘连导致渲染异常
   */
  private insertPlaceholders(editor: Editor, count: number): string[] {
    const placeholders = Array.from({ length: count }, () =>
      `![uploading...](qiniu-placeholder-${genPlaceholderId()})`
    );

    const cursor = editor.getCursor();
    const lineText = editor.getLine(cursor.line);
    const beforeChar = lineText.slice(0, cursor.ch);
    const afterChar = lineText.slice(cursor.ch);

    // 行首 / 紧邻其它内容时分别补换行
    const needLeadingNewline = beforeChar.trimEnd().length > 0;
    const needTrailingNewline = afterChar.trimStart().length > 0;

    const body = placeholders.join('\n\n');
    const text =
      (needLeadingNewline ? '\n\n' : '') +
      body +
      (needTrailingNewline ? '\n\n' : '');

    editor.replaceRange(text, cursor);
    return placeholders;
  }

  /**
   * 批量上传并按顺序插入（并发上传，顺序插入）
   */
  async uploadAndInsertMany(files: File[], editor: Editor): Promise<void> {
    const active = this.resolveActiveProvider();
    if (!active) return;
    const { provider, config } = active;

    // 占位符策略：先在光标处插入"仅含唯一 ID"的占位符，上传完成后逐个替换。
    // 占位符不含原文件名，避免特殊字符破坏 markdown 解析；ID 全局唯一以防替换错位。
    const placeholders = this.insertPlaceholders(editor, files.length);

    const notice = new Notice(`正在上传 ${files.length} 张图片到 ${provider.name}...`, 0);

    try {
      const results = await Promise.allSettled(
        files.map(file => provider.upload(
          config,
          file,
          file.name,
          this.plugin.settings.uploadTimeoutMs
        ))
      );

      // 替换每个占位符为最终 markdown 链接（或失败提示）
      let successCount = 0;
      const failedMessages: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const placeholder = placeholders[i];
        const file = files[i];
        const displayName = file.name.replace(/\.[^/.]+$/, '') || 'image';

        let replacement: string;
        if (result.status === 'fulfilled') {
          replacement = `![${displayName}](${result.value.url})`;
          successCount++;
        } else {
          const msg = getErrorMessage(result.reason);
          replacement = `<!-- 上传失败: ${msg} -->`;
          failedMessages.push(`${file.name}: ${msg}`);
        }

        // 在编辑器全文中查找占位符并替换（占位符唯一）
        this.replaceInEditor(editor, placeholder, replacement);
      }

      if (successCount === files.length) {
        new Notice(`成功上传 ${successCount} 张图片到 ${provider.name}`);
      } else if (successCount > 0) {
        new Notice(`${provider.name} 上传完成: ${successCount} 成功, ${failedMessages.length} 失败`);
        console.error('[ImageUploader] 部分上传失败:', failedMessages);
      } else {
        new Notice(`全部 ${files.length} 张图片上传到 ${provider.name} 失败`);
        console.error('[ImageUploader] 全部上传失败:', failedMessages);
      }
    } catch (error) {
      // 兜底：清理所有未替换的占位符，避免脏文本残留
      for (const placeholder of placeholders) {
        this.replaceInEditor(editor, placeholder, '<!-- 上传中断 -->');
      }
      const msg = getErrorMessage(error);
      new Notice(`上传出错: ${msg}`);
      console.error('[ImageUploader] 上传异常:', error);
    } finally {
      notice.hide();
    }
  }

  /**
   * 单文件上传（命令面板使用）
   *
   * 同样使用占位符方案，避免 await 期间用户操作导致光标错位。
   */
  async uploadAndInsert(
    file: File,
    editor: Editor,
    fileName: string
  ): Promise<void> {
    const active = this.resolveActiveProvider();
    if (!active) return;
    const { provider, config } = active;

    const [placeholder] = this.insertPlaceholders(editor, 1);
    const notice = new Notice(`正在上传图片到 ${provider.name}...`, 0);

    try {
      const result = await provider.upload(
        config,
        file,
        fileName,
        this.plugin.settings.uploadTimeoutMs
      );

      const displayName = fileName.replace(/\.[^/.]+$/, '') || 'image';
      const markdown = `![${displayName}](${result.url})`;
      this.replaceInEditor(editor, placeholder, markdown);

      new Notice(`图片已上传到 ${provider.name}`);
    } catch (error) {
      const msg = getErrorMessage(error);
      this.replaceInEditor(editor, placeholder, `<!-- 上传失败: ${msg} -->`);
      new Notice(`上传失败: ${msg}`);
      console.error('[ImageUploader] 上传失败:', error);
    } finally {
      notice.hide();
    }
  }

  /**
   * 在编辑器中查找并替换文本（仅替换首个匹配项）
   */
  private replaceInEditor(editor: Editor, search: string, replacement: string): void {
    const content = editor.getValue();
    const idx = content.indexOf(search);
    if (idx === -1) return;

    const from: EditorPosition = editor.offsetToPos(idx);
    const to: EditorPosition = editor.offsetToPos(idx + search.length);
    editor.replaceRange(replacement, from, to);
  }

  // ======================================================================
  // 右键菜单相关：本地图片识别 / 上传 / 链接替换 / 原文件后处理
  // ======================================================================

  /**
   * 在指定光标位置查找 markdown 或 wikilink 图片语法；
   * 命中且为本地图片则返回匹配信息
   */
  findLocalImageAtCursor(editor: Editor, cursor: EditorPosition): MatchedLocalImage | null {
    const line = editor.getLine(cursor.line);

    // 1. markdown ![alt](url)
    const mdRegex = createMdImageRegex();
    let m: RegExpExecArray | null;
    while ((m = mdRegex.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (cursor.ch >= start && cursor.ch <= end) {
        const link = m[2].trim();
        if (!isLocalImageLink(link)) return null;
        return {
          kind: 'md',
          alt: m[1] || '',
          link,
          fullText: m[0],
          from: { line: cursor.line, ch: start },
          to: { line: cursor.line, ch: end },
        };
      }
    }

    // 2. wikilink ![[link|alias]]
    const wikiRegex = createWikiImageRegex();
    while ((m = wikiRegex.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (cursor.ch >= start && cursor.ch <= end) {
        const link = m[1].trim();
        // wikilink 形式不带 http/data 前缀，但仍要确认后缀是图片
        const ext = this.extOfPath(link);
        if (!ext || !isImageExt(ext)) return null;
        return {
          kind: 'wiki',
          alt: (m[2] || '').trim(),
          link,
          fullText: m[0],
          from: { line: cursor.line, ch: start },
          to: { line: cursor.line, ch: end },
        };
      }
    }

    return null;
  }

  private extOfPath(p: string): string | null {
    const clean = p.split('#')[0].split('?')[0];
    const dot = clean.lastIndexOf('.');
    if (dot < 0) return null;
    return clean.slice(dot + 1);
  }

  /**
   * 把链接文本解析为 vault 中的 TFile
   * @param link  markdown 图片链接里的 url 部分 / wikilink 内的 link 部分
   * @param sourcePath 当前文档路径，用于相对路径解析
   */
  resolveLinkToFile(link: string, sourcePath: string): TFile | null {
    let path = link.split('#')[0].split('?')[0];
    try {
      path = decodeURIComponent(path);
    } catch {
      // 解码失败则用原文
    }
    return this.plugin.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
  }

  /**
   * 把 TFile 读取为 File 对象，供 provider.upload 使用
   */
  private async readVaultFileAsFile(tfile: TFile): Promise<File> {
    const buf = await this.plugin.app.vault.readBinary(tfile);
    const mime = extToMime(tfile.extension);
    return new File([buf], tfile.name, { type: mime });
  }

  /**
   * 从编辑器右键菜单触发：上传光标处本地图片，替换该处链接
   */
  async uploadLocalFromEditor(
    editor: Editor,
    view: MarkdownView,
    matched: MatchedLocalImage
  ): Promise<void> {
    const sourcePath = view.file?.path ?? '';
    const tfile = this.resolveLinkToFile(matched.link, sourcePath);
    if (!tfile) {
      new Notice(`未找到本地图片: ${matched.link}`);
      return;
    }

    const active = this.resolveActiveProvider();
    if (!active) return;
    const { provider, config } = active;

    const notice = new Notice(`正在上传 ${tfile.name} 到 ${provider.name}...`, 0);
    try {
      const file = await this.readVaultFileAsFile(tfile);
      const result = await provider.upload(
        config,
        file,
        tfile.name,
        this.plugin.settings.uploadTimeoutMs
      );

      const alt = matched.alt || tfile.basename;
      // 上传成功后，无论原始格式是 md 还是 wiki，都统一替换为 markdown 远程链接
      const replacement = `![${alt}](${result.url})`;
      // 优先用精确范围替换，避免内容变动后位置失效需做兜底
      const currentLine = editor.getLine(matched.from.line);
      const slice = currentLine.slice(matched.from.ch, matched.to.ch);
      if (slice === matched.fullText) {
        editor.replaceRange(replacement, matched.from, matched.to);
      } else {
        // 兜底：全文搜索唯一匹配
        this.replaceInEditor(editor, matched.fullText, replacement);
      }

      await this.handleLocalFileAfterUpload(tfile);
      new Notice(`已上传到 ${provider.name}`);
    } catch (error) {
      const msg = getErrorMessage(error);
      new Notice(`上传失败: ${msg}`);
      console.error('[ImageUploader] 上传本地图片失败:', error);
    } finally {
      notice.hide();
    }
  }

  /**
   * 从文件浏览器右键菜单触发：上传 vault 中的本地图片，替换 vault 内所有引用
   */
  async uploadLocalFromVault(tfile: TFile): Promise<void> {
    const active = this.resolveActiveProvider();
    if (!active) return;
    const { provider, config } = active;

    const notice = new Notice(`正在上传 ${tfile.name} 到 ${provider.name}...`, 0);
    try {
      const file = await this.readVaultFileAsFile(tfile);
      const result = await provider.upload(
        config,
        file,
        tfile.name,
        this.plugin.settings.uploadTimeoutMs
      );

      const replacedCount = await this.replaceVaultReferences(tfile, result.url);
      await this.handleLocalFileAfterUpload(tfile);

      if (replacedCount > 0) {
        new Notice(`已上传到 ${provider.name}，替换 ${replacedCount} 处引用`);
      } else {
        new Notice(`已上传到 ${provider.name}，未发现引用\nURL: ${result.url}`, 8000);
      }
    } catch (error) {
      const msg = getErrorMessage(error);
      new Notice(`上传失败: ${msg}`);
      console.error('[ImageUploader] 上传 vault 图片失败:', error);
    } finally {
      notice.hide();
    }
  }

  /**
   * 替换 vault 内所有 markdown 文件中对该 TFile 的引用：
   *  - 标准 markdown ![alt](path)
   *  - Obsidian wikilink ![[path|alias]]
   *
   * 通过 metadataCache.resolvedLinks 反查包含该文件的笔记，避免全量扫描；
   * 使用 vault.process 进行原子读改写，避免覆盖编辑器内的未保存改动。
   */
  private async replaceVaultReferences(target: TFile, url: string): Promise<number> {
    const { app } = this.plugin;
    const resolvedLinks = app.metadataCache.resolvedLinks ?? {};
    let totalReplaced = 0;

    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (!(target.path in (links as Record<string, number>))) continue;
      const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
      if (!(sourceFile instanceof TFile) || sourceFile.extension !== 'md') continue;

      let perFile = 0;
      // process 提供原子读-改-写，且与 editor buffer 协调，避免数据丢失
      await app.vault.process(sourceFile, (content) => {
        let next = content;

        // markdown 链接
        next = next.replace(createMdImageRegex(), (full, alt: string, link: string, title?: string) => {
          const cleanLink = link.trim();
          if (isRemoteLink(cleanLink)) return full;
          const dest = this.resolveLinkToFile(cleanLink, sourcePath);
          if (!dest || dest.path !== target.path) return full;
          perFile++;
          const safeAlt = alt || target.basename;
          const titlePart = title ? ` "${title}"` : '';
          return `![${safeAlt}](${url}${titlePart})`;
        });

        // wikilink 嵌入
        next = next.replace(createWikiImageRegex(), (full, link: string, alias?: string) => {
          const cleanLink = link.trim();
          const dest = this.resolveLinkToFile(cleanLink, sourcePath);
          if (!dest || dest.path !== target.path) return full;
          perFile++;
          const safeAlt = (alias && alias.trim()) || target.basename;
          return `![${safeAlt}](${url})`;
        });

        return next;
      });

      totalReplaced += perFile;
    }
    return totalReplaced;
  }

  /**
   * 根据设置 localFileAction 处理本地原文件
   */
  private async handleLocalFileAfterUpload(tfile: TFile): Promise<void> {
    const action = this.plugin.settings.localFileAction;
    if (action === 'keep') return;
    try {
      if (action === 'trash') {
        // 优先 system trash；若失败回退到 vault 内 .trash
        await this.plugin.app.vault.trash(tfile, true);
      } else if (action === 'delete') {
        await this.plugin.app.vault.delete(tfile);
      }
    } catch (e) {
      console.error('[ImageUploader] 处理本地原文件失败:', e);
      new Notice(`已上传，但处理本地文件失败: ${getErrorMessage(e)}`);
    }
  }
}
