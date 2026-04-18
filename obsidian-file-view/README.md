# All File Viewer

一个让 Obsidian 文件管理器显示 **非原生支持文件**（Excel、Word、PPT、压缩包、可执行文件、设计稿等）并支持用系统默认软件打开的插件，同时为常见文件类型提供 Lucide 风格的彩色图标徽章。

## 背景

Obsidian 默认只显示自己能渲染的文件（Markdown、常见图片、PDF、视频等），其他类型如 `.xlsx`、`.docx`、`.pptx`、`.zip`、`.exe`、`.psd` 等虽然就在 vault 目录里，却**不会出现在文件管理器**中。这让和笔记放在一起的附件很难管理。

本插件把这些扩展名"注册"到 Obsidian 让它们出现在文件树里，并提供调用系统默认软件打开的能力。同时给所有常见文件类型加上一个 Lucide 风格的彩色图标徽章，方便扫一眼就看出文件类型。

## 功能

- **显示所有文件**：在文件管理器中显示 Obsidian 默认隐藏的非原生文件
- **打开外部应用**：点击文件 → 占位面板，点击按钮调用系统默认软件打开
  - **始终需要用户确认**，不会在 Obsidian 启动恢复工作区时偷偷调起外部应用
- **右键菜单**：用默认软件打开 / 在系统资源管理器中显示
- **命令面板**：`Open current file with default app`
- **设置页**：增删自定义扩展名
- **彩色图标徽章**：文件树中按文件类型显示 Lucide 图标徽章（详见下文）
- **安全**：已被 Obsidian 或其他插件处理的扩展名（md / pdf 等会自动跳过注册，不会破坏原生预览）

## 插件注册的扩展名

下列扩展名默认会被注册到 Obsidian，使其出现在文件管理器中：

| 类别 | 扩展名 |
|---|---|
| Office | `xlsx` `xls` `xlsm` `csv` `docx` `doc` `pptx` `ppt` |
| 压缩包 | `zip` `rar` `7z` `tar` `gz` |
| 可执行 | `exe` `msi` `dmg` `apk` `app` |
| 文档 | `epub` `mobi` `rtf` `odt` `ods` `odp` |
| 设计 | `psd` `ai` `sketch` `fig` |
| 其他 | `iso` `torrent` |

可在设置中关闭默认列表，或追加自定义扩展（如 `dwg, sql, log`）。

## 文件类型徽章

无论文件是否由本插件注册（即原生支持的图片、视频也包含在内），下列扩展名都会在文件树中显示一个彩色 Lucide 图标徽章：

| 图标 | 颜色 | 文件类型 | 扩展名 |
|---|---|---|---|
| `file-spreadsheet` | 绿色 | 表格 | `xlsx` `xls` `xlsm` `csv` `ods` |
| `file-text` | 蓝色 | 文档 | `docx` `doc` `rtf` `odt` |
| `presentation` | 红橙 | 演示文稿 | `pptx` `ppt` `odp` |
| `archive` | 暗黄 | 压缩包 | `zip` `rar` `7z` `tar` `gz` `iso` |
| `app-window` | 灰色 | 应用/安装包 | `exe` `msi` `dmg` `apk` `app` |
| `book-open` | 紫色 | 电子书 | `epub` `mobi` |
| `palette` | 浅紫 | 设计稿 | `psd` `ai` `sketch` `fig` |
| `image` | 青绿 | 图片 | `png` `jpg` `jpeg` `gif` `bmp` `svg` `webp` `avif` `tiff` `tif` `ico` |
| `film` | 橙色 | 视频 | `mp4` `webm` `ogv` `mov` `mkv` `avi` `flv` `m4v` `wmv` |

> 徽章是纯 CSS（`::before` 伪元素 + `mask-image` 内联 SVG），不依赖任何外部资源，也不会干扰 Obsidian 对图片、视频、PDF 等的原生预览能力。

## 安装（手动）

> 插件未上架社区市场前，需要手动安装。

1. 构建产物：
   ```bash
   npm install
   npm run build
   ```
2. 在 vault 下创建目录：
   ```
   <Vault>/.obsidian/plugins/all-file-viewer/
   ```
3. 把以下三个文件复制进去：
   - `manifest.json`
   - `main.js`
   - `styles.css`
4. 重启 Obsidian → **设置 → 第三方插件** → 找到 **All File Viewer** 启用。

## 使用

启用后立即生效：

- 文件树中可以看到 `.xlsx` / `.docx` / `.zip` 等文件，并附带彩色图标徽章
- **单击**文件 → Obsidian 打开占位面板，点击 *Open with default app* 按钮才会调起系统默认软件
- **右键**文件 → 选择 *Open with default app* 或 *Show in system explorer* 直接打开
- **Ctrl/Cmd+P** → 输入 `Open current file with default app` 也可对当前文件触发

> 不会自动调起外部软件 —— 这是有意的设计。否则 Obsidian 启动恢复工作区时，上次打开的 Excel/Word 会被无声地拉起，体验非常糟糕。

## 设置项

| 设置 | 说明 |
|---|---|
| Disable default extensions | 关掉内置扩展名列表，只用自定义列表 |
| Extra extensions | 追加扩展名，逗号分隔，不带点（如 `dwg, sql, log`） |

设置页底部会列出**当前已实际注册**的扩展名，方便确认配置生效。

## 开发

```bash
npm install
npm run dev      # esbuild watch 模式，源码改动后自动重新编译 main.js
```

推荐把项目目录 symlink 到测试 vault 的插件目录，免去每次手动复制：

```bash
# Windows (管理员 PowerShell)
New-Item -ItemType Junction `
  -Path "<Vault>\.obsidian\plugins\all-file-viewer" `
  -Target "E:\ai-coding\obsidian-plugins\obsidian-file-view"

# macOS / Linux
ln -s /path/to/obsidian-file-view <Vault>/.obsidian/plugins/all-file-viewer
```

修改 `src/main.ts` 后保存，回到 Obsidian 用 **Ctrl+R** 重载窗口即可看到效果。

## 项目结构

```
obsidian-file-view/
├── src/main.ts           # 插件主逻辑：注册扩展、FileView、设置页
├── styles.css            # 占位面板样式 + 文件类型徽章 CSS
├── manifest.json         # Obsidian 插件清单（id: all-file-viewer）
├── package.json          # npm 元数据 + build script
├── versions.json         # 插件版本兼容矩阵
├── esbuild.config.mjs    # 打包配置
└── tsconfig.json
```

## 兼容性

- **仅桌面端**：依赖 Electron `shell.openPath` / `shell.showItemInFolder`，移动端没有"系统默认软件"概念，因此 `manifest.json` 中 `isDesktopOnly: true`。
- 已在 Obsidian 1.4+ 测试。Obsidian 1.4 起内建 `app.openWithDefaultApp(path)`，插件优先调用它，失败则回退到 Electron `shell`。

## 已知限制

- 注册的扩展名会让 Obsidian 把这些文件**当作可打开的视图**——这意味着搜索、内部链接 `[[file.xlsx]]` 等也会接管它们；如果不需要，可以从 *Extra extensions* / 默认列表中去掉。
- 本插件**不预览文件内容**，只是给个占位面板 + 调起外部软件。如果需要在 Obsidian 内预览 Office 文档，请使用其他专门插件（如 Office 文档查看器类插件）。
- 徽章用 `data-path$=".xxx"` 选择器实现，理论上会被同名后缀的隐藏文件 `.tar.xlsx` 误匹配为最末尾的后缀（即 `xlsx`），符合一般预期。

## 路线图 / 未来规划

下面是已经讨论过、但当前版本暂未实现的功能与方向。优先级按从上到下排列，欢迎在 issue 中讨论或贡献。

### 计划中

- **设置页：徽章颜色自定义**
  让用户在设置面板里覆盖 9 大类徽章的背景色，方便适配亮色/暗色主题或个人偏好。
- **设置页：自定义扩展名 → 类别映射**
  允许用户把追加的扩展名（如 `dwg`、`step`）归到某个已有徽章类别下，复用图标和颜色。
- **设置页：开关每一类徽章**
  例如不想给图片/视频加徽章（因为 Obsidian 已有原生预览图标），可以单独关闭某一类。
- **占位面板增强**
  - 显示文件大小、修改时间、所在文件夹路径快捷复制
  - 针对图片/视频/PDF 之外的可文本化文件（`.log`、`.csv`、`.sql` 等）提供首 N 行文本预览
- **更多文件类型支持**
  根据反馈持续扩充默认列表（CAD、3D 模型、字体文件、字幕等）。
- **国际化（i18n）**
  目前 UI 文案只有英文（按 Obsidian 插件主流惯例），未来按 Obsidian 1.5+ 的 i18n API 增加中文等语言。
- **命令补充**
  - `Show current file in system explorer` 命令面板入口
  - `Reveal file in vault` 等便捷动作

### 探索中（不一定实现）

- **移动端兼容**
  iOS/Android 没有"系统默认软件"概念，但徽章样式部分理论上可以工作。需要重构以拆分 Desktop-only 代码。
- **`Open with...` 子菜单**
  让用户为某个扩展名指定具体的外部程序路径（绕开系统默认关联）。涉及跨平台命令行调用与安全性，需谨慎。

### 明确不做

- **Office 文档内容预览（xlsx/docx/pptx 内嵌渲染）**
  这需要引入 SheetJS / mammoth.js / pptxgenjs 等重型依赖，且渲染保真度有限、字体/公式/图表问题多。本插件定位是"补全文件管理 + 调起外部软件"，预览交给专业的 Office 查看器插件。
- **自动打开外部软件**
  历史上实现过但已删除。Obsidian 启动恢复工作区时会无声拉起上次的 Excel/Word，体验灾难。**始终需要用户点按钮或菜单确认**。
- **修改/写入外部文件**
  插件不会读取或修改外部文件内容，只做"展示 + 调用系统打开"。

## License

MIT
