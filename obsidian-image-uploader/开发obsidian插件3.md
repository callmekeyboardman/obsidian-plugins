# 开发 Obsidian 插件：七牛云图片上传（代码审查与全面修复）

## 一、本次工作概述

本轮工作针对插件进行**全面代码审查**，发现 **18 个问题**（4 严重、6 中等、8 轻微），并完成全部修复。

最终结果：

- `npm run build` 通过
- `npx tsc --noEmit` 类型检查通过
- 新增 `versions.json`、`.gitignore`
- 新增向后兼容的设置迁移逻辑

---

## 二、问题清单与修复

### 2.1 严重问题（🔴）

#### 问题 1: 事件冒泡处理不完善

**位置**: `src/imageHandler.ts:21-31`

**问题**: 在 `editor-paste` / `editor-drop` 事件中循环内多次调用 `evt.preventDefault()`，但未阻止事件继续冒泡，可能与 Obsidian 默认上传到本地 vault 的行为冲突。

**修复**: 提前 `preventDefault`，并增加 `stopPropagation()` 与 `defaultPrevented` 检查。

```typescript
async handlePaste(evt: ClipboardEvent, editor: Editor, _view: MarkdownView): Promise<void> {
  if (!this.plugin.settings.enabled) return;
  if (evt.defaultPrevented) return;

  // 先收集所有图片
  const files: File[] = [];
  // ...
  if (files.length === 0) return;

  // 阻止 Obsidian 默认行为
  evt.preventDefault();
  evt.stopPropagation();

  await this.uploadAndInsertMany(files, editor);
}
```

---

#### 问题 2: Base64 大文件转换爆栈/卡死

**位置**: `src/qiniuUploader.ts:134-139`

**问题**:

```typescript
const base64Image = Array.from(uint8Array)
  .map(b => String.fromCharCode(b))
  .join('');
const imgBase64 = btoa(base64Image);
```

`Array.from(uint8Array)` 对几 MB 图片会创建巨大数组，`btoa()` 处理大字符串极慢，且整个过程内存占用爆炸。

**修复**: 改用 `FileReader.readAsDataURL()`，由浏览器原生高效完成：

```typescript
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader 返回类型异常'));
        return;
      }
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.substring(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(blob);
  });
}
```

---

#### 问题 3: HTTP 明文上传，Token 可被截获

**位置**: `src/types.ts:23-26`

**问题**: `getUploadUrl()` 返回 `http://upload.qiniup.com`，Token 与图片数据通过明文传输。Token 一旦被截获，可在 1 小时内任意写入该 Bucket。

**修复**: 全部改为 HTTPS：

```typescript
export function getUploadUrl(area: string): string {
  const areaSuffix = area === 'z0' ? '' : `-${area}`;
  return `https://upload${areaSuffix}.qiniup.com`;
}
```

---

#### 问题 4: 多图粘贴串行上传，cursor 错位

**位置**: `src/imageHandler.ts:21-29`

**问题**:

- 多张图片串行 `await` 上传，体验极差
- 每次插入后 cursor 已经移动，但读取时机错误，导致位置混乱

**修复**: **占位符策略** —— 先在光标处插入所有占位符，再并发上传，完成后逐个替换占位符：

```typescript
async uploadAndInsertMany(files: File[], editor: Editor): Promise<void> {
  // 1. 先插入占位符
  const cursor = editor.getCursor();
  const placeholders = files.map((f, i) =>
    `![uploading ${f.name}...](upload-placeholder-${Date.now()}-${i})`
  );
  editor.replaceRange(placeholders.join('\n'), cursor);

  // 2. 并发上传
  const results = await Promise.allSettled(
    files.map(file => uploadToQiniu(
      this.plugin.settings.qiniu,
      file,
      file.name,
      this.plugin.settings.uploadTimeoutMs
    ))
  );

  // 3. 逐个替换占位符
  for (let i = 0; i < results.length; i++) {
    const placeholder = placeholders[i];
    const replacement = results[i].status === 'fulfilled'
      ? `![${displayName}](${results[i].value})`
      : `<!-- 上传失败: ${msg} -->`;
    this.replaceInEditor(editor, placeholder, replacement);
  }
}
```

**优点**:

- 用户立即看到占位符反馈，知道上传已触发
- 上传完全并发，速度大幅提升
- 失败的图片转为 HTML 注释，用户可见但不影响渲染

---

### 2.2 中等问题（🟡）

#### 问题 5: `error.message` 未做类型守卫

**位置**: `src/imageHandler.ts:102`

**修复**: 统一封装 `getErrorMessage()` 工具函数：

```typescript
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
```

---

#### 问题 6: Token 每次上传都重新生成

**位置**: `src/qiniuUploader.ts:56-75`

**问题**: Token 有 1 小时有效期，但每次上传都重新计算 HMAC-SHA1 签名。

**修复**: `Map` 缓存 Token，401/403 时自动清除：

```typescript
interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();
const TOKEN_TTL_SECONDS = 3600;
const TOKEN_REFRESH_BUFFER = 5 * 60;

async function getToken(config: QiniuConfig): Promise<string> {
  const cacheKey = `${config.accessKey}:${config.bucket}`;
  const nowSec = Math.floor(Date.now() / 1000);

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REFRESH_BUFFER > nowSec) {
    return cached.token;
  }

  // ...生成新 Token
  tokenCache.set(cacheKey, { token, expiresAt: deadline });
  return token;
}

// 设置变更时清除缓存
export function clearTokenCache(): void {
  tokenCache.clear();
}
```

并在上传失败时智能清除：

```typescript
if (response.status === 401 || response.status === 403) {
  tokenCache.delete(`${config.accessKey}:${config.bucket}`);
}
```

---

#### 问题 7: 文件名生成边界 bug

**位置**: `src/qiniuUploader.ts:80-92`

**问题**:

- `.gitignore` 等以 `.` 开头的文件名，`split('.').pop()` 会返回 `'gitignore'`
- 用户填 `path = 'images'`（无尾斜杠）时会粘连为 `images1716...png`

**修复**:

```typescript
function normalizePath(path: string): string {
  if (!path) return '';
  return path.endsWith('/') ? path : path + '/';
}

function generateFileName(config: QiniuConfig, originalFileName: string): string {
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);

  // 仅当 '.' 不是首字符时才视为扩展名分隔符
  const dotIdx = originalFileName.lastIndexOf('.');
  const ext = dotIdx > 0 ? originalFileName.substring(dotIdx) : '';

  const baseName = `${timestamp}${randomStr}${ext}`;
  const prefix = normalizePath(config.path);
  return `${prefix}${baseName}`;
}
```

---

#### 问题 8: URL 拼接产生双斜杠

**位置**: `src/qiniuUploader.ts:170`

**问题**: 用户填 `https://example.com/`（带尾斜杠）时拼接出 `https://example.com//xxx.png`。

**修复**:

```typescript
function joinUrl(baseUrl: string, key: string, suffix: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedKey = key.replace(/^\/+/, '');
  return `${trimmedBase}/${trimmedKey}${suffix || ''}`;
}
```

---

#### 问题 9: 移动端 Clipboard API 不可用

**位置**: `main.ts:48`

**问题**: `manifest.json` 设置 `isDesktopOnly: false`，但 Clipboard API 在 iOS/Android Obsidian 上支持有限。

**修复**: 检测 API 可用性 + 平台判断：

```typescript
if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
  new Notice(
    Platform.isMobile
      ? '移动端不支持读取剪贴板图片，请使用粘贴方式'
      : '当前环境不支持 Clipboard API，请直接粘贴图片'
  );
  return;
}
```

并修复扩展名硬编码为 `.png` 的问题：

```typescript
const ext = imageTypes[0].split('/')[1] || 'png';
const file = new File([blob], `clipboard-image.${ext}`, { type: imageTypes[0] });
```

---

#### 问题 10: 密钥明文存储无任何提示

**位置**: README

**修复**: README 新增"安全提示"章节：

```markdown
## 安全提示

- **Access Key / Secret Key 以明文形式存储在 vault 的 `.obsidian/plugins/qiniu-image-uploader/data.json`**
- 若使用 Git 同步 vault，请将该文件加入 `.gitignore`，避免密钥泄露
- 若使用 Obsidian Sync / 第三方云同步服务，请评估其端到端加密能力
- 建议在七牛云控制台为该 Bucket 创建**独立的子账号密钥**并仅授予 `upload` 权限
```

---

### 2.3 轻微/优化问题（🟢）

#### 问题 11: Secret Key 应用密码框

**位置**: `src/settings.ts:46`

**修复**: 通过 `text.inputEl.type = 'password'` 隐藏输入：

```typescript
.addText(text => {
  text.inputEl.type = 'password';
  text
    .setPlaceholder('请输入 Secret Key')
    .setValue(this.plugin.settings.qiniu.secretKey)
    .onChange(async (value) => {
      this.plugin.settings.qiniu.secretKey = value.trim();
      await this.saveAndInvalidate();
    });
});
```

Access Key 同样处理。

---

#### 问题 12: 使用 `<h2>` 标题不符合 Obsidian 规范

**位置**: `src/settings.ts:17`

**修复**: 改用官方推荐的 `Setting().setHeading()`：

```typescript
new Setting(containerEl).setName('七牛云图片上传').setHeading();
```

---

#### 问题 13: 多余的 `console.log`

**位置**: `main.ts:11,68`

**修复**: 移除 `Loading...` / `Unloading...` 日志，仅保留错误日志（带 `[Qiniu Uploader]` 前缀便于过滤）。

---

#### 问题 14: Notice 释放不可靠

**位置**: `src/imageHandler.ts:75`

**修复**: 全部改为 `try/finally`：

```typescript
const notice = new Notice('正在上传图片到七牛云...', 0);
try {
  // ...上传逻辑
} catch (error) {
  // ...错误处理
} finally {
  notice.hide();
}
```

---

#### 问题 15: fetch 缺少超时控制

**位置**: `src/qiniuUploader.ts`

**修复**: 使用 `AbortController` 实现可配置超时：

```typescript
async function fetchWithTimeout(
  input: RequestInfo,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(`上传超时（${timeoutMs}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

设置面板新增"上传超时（秒）"配置项，默认 30 秒。

---

#### 问题 16: `PluginSettings extends QiniuConfig` 设计混淆

**位置**: `src/types.ts:35`

**问题**: 配置和插件 UI 状态扁平化耦合。

**修复**: 拆分为嵌套结构，并提供向后兼容迁移：

```typescript
export interface PluginSettings {
  enabled: boolean;
  uploadTimeoutMs: number;
  qiniu: QiniuConfig;
}

/**
 * 兼容旧版扁平化配置：
 * { enabled, accessKey, ... } → { enabled, qiniu: {...} }
 */
export function migrateSettings(raw: unknown): PluginSettings {
  const data = (raw ?? {}) as Record<string, unknown>;

  // 已是新版结构
  if ('qiniu' in data && data.qiniu && typeof data.qiniu === 'object') {
    return {
      enabled: typeof data.enabled === 'boolean' ? data.enabled : DEFAULT_SETTINGS.enabled,
      uploadTimeoutMs: typeof data.uploadTimeoutMs === 'number' ? data.uploadTimeoutMs : DEFAULT_SETTINGS.uploadTimeoutMs,
      qiniu: { ...DEFAULT_QINIU_CONFIG, ...(data.qiniu as Partial<QiniuConfig>) },
    };
  }

  // 旧版扁平化结构 → 新版
  const legacy = data as LegacyFlatSettings;
  return {
    enabled: typeof legacy.enabled === 'boolean' ? legacy.enabled : DEFAULT_SETTINGS.enabled,
    uploadTimeoutMs: DEFAULT_SETTINGS.uploadTimeoutMs,
    qiniu: {
      accessKey: legacy.accessKey ?? '',
      secretKey: legacy.secretKey ?? '',
      // ...
    },
  };
}
```

老用户升级后，`loadSettings` 会自动迁移并保存为新结构，无感知。

---

#### 问题 17: 缺少 `versions.json`

**修复**: 新增文件以便 Obsidian 社区市场识别版本兼容性：

```json
{
  "1.0.0": "0.15.0"
}
```

---

#### 问题 18: 缺少 `.gitignore`

**修复**: 新增，特别强调 `data.json` 需忽略以防密钥泄露：

```
node_modules/
main.js
*.js.map
.vscode/
.idea/
.DS_Store

# Plugin local data (contains secrets!)
data.json
```

---

## 三、tsconfig 修复

修复过程中发现 LSP 报错：

```
This syntax requires an imported helper but module 'tslib' cannot be found.
```

原因：`tsconfig.json` 启用了 `importHelpers: true`，但项目未安装 `tslib` 依赖。

**修复**: 关闭 `importHelpers`：

```diff
-    "importHelpers": true,
+    "importHelpers": false,
```

---

## 四、修复后的目录结构

```
obsidian-image-uploader/
├── main.ts                  # 插件主入口（含设置迁移、移动端检测）
├── manifest.json
├── package.json
├── esbuild.config.mjs
├── tsconfig.json            # 关闭 importHelpers
├── versions.json            # 🆕 Obsidian 版本兼容
├── .gitignore               # 🆕 防泄密
├── styles.css
├── README.md                # 🆕 安全提示章节
├── 开发obsidian插件1.md
├── 开发obsidian插件2.md
├── 开发obsidian插件3.md     # 🆕 本文
└── src/
    ├── types.ts             # 拆分配置 + 迁移函数
    ├── settings.ts          # 密码框 / setHeading / 超时配置
    ├── imageHandler.ts      # 多图并发 + 占位符 + try/finally
    └── qiniuUploader.ts     # HTTPS / FileReader / Token 缓存 / 超时
```

---

## 五、修复成果总结

| 等级 | 数量 | 主要价值 |
|------|------|---------|
| 🔴 严重 | 4 | 安全性（HTTPS）、可用性（大文件）、体验（多图并发） |
| 🟡 中等 | 6 | 健壮性（超时、错误处理）、性能（Token 缓存） |
| 🟢 轻微 | 8 | 规范性（密码框、setHeading）、可维护性（配置拆分） |

### 5.1 关键设计亮点

1. **设置无感升级**：`migrateSettings()` 自动把旧版扁平 `data.json` 升级为新结构，老用户零迁移成本。
2. **Token 自愈机制**：上传遇到 401/403 时自动清除 Token 缓存，下次自动重新签名。
3. **占位符上传体验**：多图上传立即可见占位符，并发完成后逐个替换为正式链接，失败保留为 HTML 注释。
4. **超时可配置**：`AbortController` 实现，避免网络挂起导致永久 Notice。

### 5.2 验证

```bash
$ npx tsc --noEmit
# (无错误)

$ npm run build
> qiniu-image-uploader@1.0.0 build
> node esbuild.config.mjs production
# (构建成功)
```

---

## 六、改动文件清单

| 文件 | 改动类型 |
|------|---------|
| `main.ts` | ✏️ 修改 |
| `tsconfig.json` | ✏️ 修改 |
| `README.md` | ✏️ 修改 |
| `src/types.ts` | ✏️ 修改 |
| `src/qiniuUploader.ts` | ✏️ 重写 |
| `src/imageHandler.ts` | ✏️ 重写 |
| `src/settings.ts` | ✏️ 重写 |
| `versions.json` | ➕ 新增 |
| `.gitignore` | ➕ 新增 |
| `开发obsidian插件3.md` | ➕ 新增（本文） |

---

## 七、经验总结

1. **代码审查应分等级**：严重 → 中等 → 轻微，优先修复影响安全和功能的问题。
2. **大文件处理优先用浏览器原生 API**：`FileReader` 比手动 Base64 转换高效得多。
3. **HTTPS 不是可选项**：任何携带 Token / 密钥的请求都必须 HTTPS。
4. **配置变更要做迁移**：拆分数据结构时，必须为老用户提供透明的迁移路径。
5. **错误处理要类型安全**：`unknown` catch 配合工具函数 `getErrorMessage()` 是 TypeScript 最佳实践。
6. **Token 缓存要带失效机制**：缓存命中要算上"提前刷新缓冲时间"，失败响应要主动清除缓存。
7. **多图并发用 `Promise.allSettled`**：保证单张失败不影响其他图片上传。
