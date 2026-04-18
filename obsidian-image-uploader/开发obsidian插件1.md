# 开发 Obsidian 插件实战指南

以开发"七牛云图片上传插件"为例，记录完整的开发流程。

---

## 一、项目初始化

### 1.1 创建项目结构

```
obsidian-image-uploader/
├── manifest.json           # 插件元数据（必需）
├── package.json            # npm 配置（必需）
├── tsconfig.json           # TypeScript 配置（必需）
├── esbuild.config.mjs      # 构建配置（必需）
├── main.ts                 # 插件入口源码
├── main.js                 # 构建产物（Obsidian 加载此文件）
├── styles.css              # 样式（可选）
├── README.md               # 文档（可选）
└── src/                    # 源码目录
    ├── types.ts            # 类型定义
    ├── qiniuUploader.ts    # 核心上传逻辑
    ├── settings.ts         # 设置界面
    └── imageHandler.ts     # 事件处理
```

### 1.2 创建 manifest.json

Obsidian 插件必需文件，定义插件基本信息：

```json
{
  "id": "qiniu-image-uploader",
  "name": "Qiniu Image Uploader",
  "version": "1.0.0",
  "minAppVersion": "0.15.0",
  "description": "Upload images to Qiniu cloud storage",
  "author": "Your Name",
  "authorUrl": "https://github.com",
  "isDesktopOnly": false
}
```

### 1.3 创建 package.json

```json
{
  "name": "qiniu-image-uploader",
  "version": "1.0.0",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "node esbuild.config.mjs production"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "builtin-modules": "^3.3.0",
    "esbuild": "^0.20.0",
    "obsidian": "latest",
    "typescript": "^5.0.0"
  }
}
```

### 1.4 创建 tsconfig.json

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "inlineSourceMap": true,
    "module": "ESNext",
    "target": "ES6",
    "moduleResolution": "node",
    "strictNullChecks": true,
    "lib": ["DOM", "ES5", "ES6", "ES7"]
  },
  "include": ["**/*.ts"]
}
```

### 1.5 创建 esbuild.config.mjs

Obsidian 插件使用 esbuild 打包：

```javascript
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  sourcemap: prod ? false : "inline",
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch(); // 开发模式热重载
}
```

---

## 二、核心代码实现

### 2.1 插件入口 main.ts

继承 `Plugin` 类，实现生命周期方法：

```typescript
import { Plugin, MarkdownView } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from './src/types';
import { QiniuUploaderSettingTab } from './src/settings';
import { ImageHandler } from './src/imageHandler';

export default class QiniuImageUploaderPlugin extends Plugin {
  settings: PluginSettings;
  private imageHandler: ImageHandler;

  async onload() {
    // 1. 加载设置
    await this.loadSettings();

    // 2. 初始化处理器
    this.imageHandler = new ImageHandler(this);

    // 3. 注册事件监听
    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt, editor, view) => {
        this.imageHandler.handlePaste(evt, editor, view);
      })
    );

    this.registerEvent(
      this.app.workspace.on('editor-drop', (evt, editor, view) => {
        this.imageHandler.handleDrop(evt, editor, view);
      })
    );

    // 4. 添加设置面板
    this.addSettingTab(new QiniuUploaderSettingTab(this.app, this));

    // 5. 添加命令
    this.addCommand({
      id: 'upload-clipboard-image',
      name: '上传剪贴板图片到七牛云',
      callback: async () => { /* ... */ }
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
```

### 2.2 类型定义 types.ts

定义配置接口和常量：

```typescript
export interface QiniuConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  url: string;      // 访问域名
  area: string;     // 区域代码
  options: string;  // URL 后缀
  path: string;     // 存储路径
}

export interface PluginSettings extends QiniuConfig {
  enabled: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  enabled: true,
  accessKey: '',
  secretKey: '',
  bucket: '',
  url: '',
  area: 'z0',
  options: '',
  path: '',
};

// 区域上传端点
export function getUploadUrl(area: string): string {
  const suffix = area === 'z0' ? '' : `-${area}`;
  return `http://upload${suffix}.qiniup.com`;
}
```

### 2.3 设置界面 settings.ts

使用 `PluginSettingTab` 创建设置 UI：

```typescript
import { App, PluginSettingTab, Setting, Notice } from 'obsidian';

export class QiniuUploaderSettingTab extends PluginSettingTab {
  plugin: QiniuImageUploaderPlugin;

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '七牛云图片上传设置' });

    // 文本输入
    new Setting(containerEl)
      .setName('Access Key')
      .setDesc('七牛云 Access Key')
      .addText(text => text
        .setValue(this.plugin.settings.accessKey)
        .onChange(async (value) => {
          this.plugin.settings.accessKey = value;
          await this.plugin.saveSettings();
        }));

    // 下拉选择
    new Setting(containerEl)
      .setName('存储区域')
      .addDropdown(dropdown => {
        dropdown.addOption('z0', '华东');
        dropdown.addOption('z1', '华北');
        dropdown.setValue(this.plugin.settings.area)
          .onChange(async (value) => {
            this.plugin.settings.area = value;
            await this.plugin.saveSettings();
          });
      });

    // 测试按钮
    new Setting(containerEl)
      .setName('测试上传')
      .addButton(button => button
        .setButtonText('测试上传')
        .onClick(async () => {
          await this.testUpload();
        }));
  }
}
```

### 2.4 图片处理 imageHandler.ts

处理粘贴和拖放事件：

```typescript
import { Editor, MarkdownView, Notice } from 'obsidian';
import { uploadToQiniu } from './qiniuUploader';

export class ImageHandler {
  constructor(private plugin: QiniuImageUploaderPlugin) {}

  async handlePaste(evt: ClipboardEvent, editor: Editor): Promise<void> {
    if (!this.plugin.settings.enabled) return;

    const items = evt.clipboardData?.items;
    for (const item of items || []) {
      if (item.type.startsWith('image/')) {
        evt.preventDefault();
        const file = item.getAsFile();
        if (file) {
          await this.uploadAndInsert(file, editor, file.name);
        }
      }
    }
  }

  async uploadAndInsert(file: File, editor: Editor, fileName: string): Promise<void> {
    try {
      const url = await uploadToQiniu(this.plugin.settings, file, fileName);
      const markdown = `![${fileName}](${url})`;
      const cursor = editor.getCursor();
      editor.replaceRange(markdown, cursor);
      new Notice('上传成功！');
    } catch (error) {
      new Notice(`上传失败: ${error.message}`);
    }
  }
}
```

---

## 三、七牛云上传核心实现

### 3.1 上传 Token 生成算法

七牛云上传需要生成 Token，格式为：

```
accessKey:encodedSignature:encodedPolicy
```

**算法步骤：**

1. 创建上传策略 JSON
2. Base64 URL-safe 编码策略
3. HMAC-SHA1 签名（用 secretKey）
4. Base64 URL-safe 编码签名
5. 组合 Token

```typescript
// Base64 URL-safe 编码
function base64ToUrlSafe(value: string): string {
  return value.replace(/\//g, '_').replace(/\+/g, '-');
}

function urlSafeBase64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
  return base64ToUrlSafe(btoa(binary));
}

// HMAC-SHA1 签名（使用 Web Crypto API）
async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  const binary = Array.from(new Uint8Array(signature))
    .map(b => String.fromCharCode(b))
    .join('');
  return btoa(binary);
}

// 生成 Token
async function getToken(config: QiniuConfig): Promise<string> {
  const policy = {
    scope: config.bucket,
    deadline: Math.floor(Date.now() / 1000) + 3600
  };
  const encodedFlags = urlSafeBase64Encode(JSON.stringify(policy));
  const encodedSign = base64ToUrlSafe(await hmacSha1Base64(config.secretKey, encodedFlags));
  return `${config.accessKey}:${encodedSign}:${encodedFlags}`;
}
```

### 3.2 Base64 上传方式

七牛云支持两种上传方式，Base64 方式更简单：

```typescript
export async function uploadToQiniu(
  config: QiniuConfig,
  file: File | Blob,
  fileName: string
): Promise<string> {
  const uploadUrl = getUploadUrl(config.area);
  const token = await getToken(config);

  // 文件转 Base64
  const arrayBuffer = await file.arrayBuffer();
  const imgBase64 = btoa(Array.from(new Uint8Array(arrayBuffer))
    .map(b => String.fromCharCode(b)).join(''));

  // 文件名编码
  const base64FileName = urlSafeBase64Encode(key);

  // 上传请求
  const url = `${uploadUrl}/putb64/-1/key/${base64FileName}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `UpToken ${token}`,
      'Content-Type': 'image/png'
    },
    body: imgBase64
  });

  const result = await response.json();
  return `${config.url}/${result.key}`;
}
```

---

## 四、遇到的问题与解决

### 4.1 Token 生成错误 (401 Unauthorized)

**问题：** 上传时报 `{"error":"bad token","error_code":"BadToken"}`

**原因：** 
- `btoa()` 只支持 Latin1 字符，无法处理 UTF-8
- Base64 编码后需要转换为 URL-safe 格式

**解决：**
```typescript
// 正确做法：先用 TextEncoder 处理 UTF-8
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
  return btoa(binary);
}
```

### 4.2 Git 换行符警告

**问题：** `LF will be replaced by CRLF`

**解决：**
```bash
# 方案一：禁止转换
git config --global core.autocrlf false

# 方案二：添加 .gitattributes
* text=auto
*.ts text eol=lf
*.js text eol=lf
```

---

## 五、构建与安装

### 5.1 安装依赖并构建

```bash
cd obsidian-image-uploader
npm install
npm run build
```

### 5.2 安装到 Obsidian

1. 将 `main.js`, `manifest.json`, `styles.css` 复制到：
   ```
   <vault>/.obsidian/plugins/qiniu-image-uploader/
   ```

2. 重启 Obsidian，在设置 > 社区插件中启用

---

## 六、关键知识点总结

| 知识点 | 说明 |
|--------|------|
| `Plugin` 类 | 插件基类，实现 `onload()` 和 `onunload()` |
| `registerEvent()` | 注册事件监听器 |
| `addSettingTab()` | 添加设置面板 |
| `addCommand()` | 添加命令面板命令 |
| `PluginSettingTab` | 设置 UI 类，使用 `Setting` 组件 |
| `loadData()` / `saveData()` | 持久化设置数据 |
| `Editor` | 操作编辑器内容，如 `replaceRange()` |
| Web Crypto API | 浏览器端 HMAC 签名 |
| esbuild | Obsidian 插件打包工具 |

---

## 七、参考资源

- [Obsidian Plugin Developer Docs](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)
- [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
- [七牛云上传文档](https://developer.qiniu.com/kodo)
- [PicGo-Core 源码](https://github.com/PicGo/PicGo-Core)（参考上传实现）