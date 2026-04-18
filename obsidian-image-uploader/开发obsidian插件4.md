# 开发 Obsidian 插件（四）：代码 Review 与问题修复

本篇记录对当前 `obsidian-image-uploader` 插件的一次完整代码 review，列出所有发现的问题与修复方案，并落地修复。

## 一、Review 概览

整体质量较高：
- 模块拆分清晰：`types / qiniuUploader / imageHandler / settings`
- 上传链路完备：Token 缓存 + 超时 + 401/403 失效自动清理
- 处理细节用心：`utf8ToBase64` 支持中文、`FileReader` 转 base64 避免大文件爆栈、AK/SK 用 password 输入框
- 提供 `migrateSettings` 做向后兼容

下面按严重度梳理问题清单。

---

## 二、问题清单

### 🔴 P0 必须修

#### P0-1 `qiniuUploader.ts:182` AbortError 类型判断脆弱

```ts
if ((err as { name?: string }).name === 'AbortError') {
  throw new Error(`上传超时（${timeoutMs}ms）`);
}
```

不同运行时（浏览器 / Electron / Node fetch）抛出的中止异常类型可能不同，name 也未必一致。更可靠的做法是直接看 `controller.signal.aborted`。

**修复方案**：

```ts
if (controller.signal.aborted) {
  throw new Error(`上传超时（${timeoutMs}ms）`);
}
```

#### P0-2 `imageHandler.ts:97-101` 占位符唯一性 + 多图换行

原实现：

```ts
const placeholders = files.map((f, i) => {
  const safeName = f.name.replace(/[\[\]()]/g, '_') || `image-${i + 1}`;
  return `![uploading ${safeName}...](upload-placeholder-${Date.now()}-${i})`;
});
const placeholderText = placeholders.join('\n');
```

存在三个问题：

1. **占位符冲突风险**：`Date.now() + i` 在两次连续粘贴时可能撞车，进而 `replaceInEditor` 替换错位置。
2. **文件名清洗不够**：仅去掉 `[]()`，`!` `\n` `\\` 等仍可能破坏 markdown 显示。
3. **多图未空行分隔**：`'\n'` 拼接时图片间在渲染上可能被合并为同一段落。

**修复方案**：占位符里**只放唯一 ID**，用 `crypto.randomUUID()`（或退化方案）保证全局唯一；多图之间用 `'\n\n'`：

```ts
const placeholders = files.map((_, i) => {
  const id = (crypto.randomUUID?.() ?? `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 10)}`);
  return `![uploading...](qiniu-placeholder-${id})`;
});
const placeholderText = placeholders.join('\n\n');
```

---

### 🟡 P1 建议修

#### P1-1 `main.ts:81` `onunload` 未清理 Token 缓存

插件卸载/禁用时 `tokenCache` 中的派生数据仍驻留内存。应在 `onunload` 调用 `clearTokenCache()`。

#### P1-2 `settings.ts:117,129` `path` 与 `options` 没 `.trim()`

其它字段都做了 `.trim()`，这两个应保持一致，避免末尾空格导致 URL 拼接异常。

#### P1-3 `settings.ts:140-145` 超时输入无效时静默忽略

用户输错时既无提示，也不回退原值。建议：
- 输入框使用 `type="number"` + `min="1"`
- 失焦后做一次校验，无效时 `Notice` 提示并回填上次合法值

---

### 🟢 P2 优化建议

#### P2-1 `qiniuUploader.ts:213` MIME 仅基于扩展名

`File` 对象通常已经带 `file.type`，应优先使用：

```ts
const contentType = (file as File).type || getMimeType(fileName);
```

#### P2-2 `imageHandler.ts:48` 粘贴事件吞掉所有内容

只要剪贴板里包含图片就 `evt.preventDefault()`，会把同时存在的 text/html、text/plain 一起吞掉（如从浏览器复制图文混排时）。

**修复策略（保守）**：当剪贴板里**同时存在文本**时，仍上传图片，但不阻止默认行为，让 Obsidian 自行处理文本；或者文档里明确说明该限制。

本次落地选择简单策略：**仅当剪贴板内容只包含图片（不含 text）时阻止默认行为**；其余情况优先上传图片但保留默认文本插入逻辑会导致重复，所以反向处理 —— 含文本时跳过本次上传，由 Obsidian 默认处理；用户若只想要图片，可清空文本后再粘贴或用命令面板。

> 注：该交互策略可在后续按用户反馈再调整。

---

## 三、修复落地

按上面优先级依次修复，并通过 `npm run build` 验证编译通过。

修复涉及文件：
- `src/qiniuUploader.ts` — AbortError 判断、`file.type` 优先
- `src/imageHandler.ts` — 占位符唯一性、多图换行、粘贴策略
- `main.ts` — `onunload` 清理 Token 缓存
- `src/settings.ts` — `path` / `options` trim、超时输入校验

修复完成后构建产物 `main.js` 自动更新。

---

## 四、可扩展性重构（Provider 抽象）

为了将来能接入阿里云 OSS / 腾讯云 COS / S3 等图床，对架构做了一次完整重构。

### 4.1 设计目标

- 新增图床只需实现一个 `ImageUploader` 接口并注册，**无需改动** `imageHandler` 与 `settings` 主体。
- 设置面板根据 provider 声明的字段元数据**自动渲染**，杜绝大段 `if (provider === 'xxx')` 分支。
- 多套配置共存：切换图床时上一个 provider 的配置不丢失。
- 完全向后兼容：旧版 v1 扁平结构与 v2 `qiniu` 嵌套结构都能平滑迁移。

### 4.2 新目录结构

```
src/
  providers/
    types.ts               # ImageUploader / ProviderField / UploadResult
    registry.ts            # registerProvider / getProvider / listProviders / getProviderOptions
    index.ts               # initBuiltinProviders（统一注册入口）+ re-exports
    qiniu/
      types.ts             # QiniuConfig 等七牛专属类型
      uploader.ts          # 实际的七牛上传实现 + clearTokenCache
      index.ts             # qiniuProvider: ImageUploader<QiniuConfig>
  imageHandler.ts          # 通过 active provider 上传，不再耦合具体云厂商
  settings.ts              # 根据 provider.fields 动态渲染
  types.ts                 # 仅保留 PluginSettings / migrateSettings / buildDefaultSettings
main.ts                    # onload 时调用 initBuiltinProviders()
```

### 4.3 核心抽象

```ts
export interface ImageUploader<TConfig = unknown> {
  readonly id: string;
  readonly name: string;
  readonly fields: ReadonlyArray<ProviderField>;

  defaultConfig(): TConfig;
  validate(config: TConfig): string | null;
  upload(config: TConfig, file: File | Blob, fileName: string, timeoutMs: number): Promise<UploadResult>;
  clearCache?(): void;
}
```

`ProviderField` 描述单个配置字段（key/name/type/options/required/...），驱动设置面板通用渲染逻辑。

### 4.4 PluginSettings 新结构（v3）

```ts
interface PluginSettings {
  enabled: boolean;
  uploadTimeoutMs: number;
  activeProvider: string;                  // 当前生效的 provider id
  providers: Record<string, unknown>;      // 每个 provider 各存一份配置
}
```

### 4.5 设置迁移（v1 / v2 → v3）

`migrateSettings` 自动识别三种历史结构：

- **v1**（最早扁平）：`{ enabled, accessKey, secretKey, ... }` → 聚合为 `providers.qiniu`，`activeProvider='qiniu'`
- **v2**（第一次重构）：`{ enabled, uploadTimeoutMs, qiniu: {...} }` → `providers.qiniu` + `activeProvider='qiniu'`
- **v3**（当前）：直接合并字段，并对每个 provider 用其 `defaultConfig()` 兜底，避免新增字段缺失

未注册的 provider 配置原样保留（便于将来加载该 provider 时恢复），不做丢弃。

### 4.6 新增图床的步骤示例（以阿里云 OSS 为例）

1. 新建 `src/providers/aliyun-oss/{types,uploader,index}.ts`
2. 实现 `aliyunOssProvider: ImageUploader<AliyunOssConfig>`，声明 `fields` 元数据
3. 在 `src/providers/index.ts` 的 `initBuiltinProviders()` 中追加：
   ```ts
   registerProvider(aliyunOssProvider);
   ```
4. 完成。设置面板会自动出现"阿里云 OSS"选项与对应的字段表单；`migrateSettings` 会自动初始化默认配置。

### 4.7 验证

- `npm run build` 通过，`main.js` 已重新生成
- 旧版用户首次升级后，原有七牛配置会自动迁移到 `providers.qiniu` 并继续工作
- 切换 provider 时各自配置独立保存

---

## 五、后续优化清单（TODO）

按 **实际收益 / 投入比** 排序，便于后续按优先级推进。

### 🟢 高 ROI（建议优先做）

#### 5.0 支持右键上传


#### 5.1 文件名生成策略可配置
当前 `src/providers/qiniu/uploader.ts:generateFileName` 用 `${timestamp}${random}${ext}` 硬编码。常见用户需求：
- 按日期分目录：`2026/04/18/xxx.png`
- 保留原文件名：`originalname-{hash}.png`
- 自定义模板：`{yyyy}/{mm}/{filename}-{rand}{ext}`

**方案**：在 `QiniuConfig` 增加 `fileNameTemplate` 字段，provider 内部做模板替换。
变量建议：`{yyyy} {mm} {dd} {hh} {mi} {ss} {timestamp} {rand} {ext} {filename}`。

#### 5.2 上传前压缩 / 转格式
PNG 截图常常几 MB，压缩成 webp/jpeg 能省 80% 流量。
- 用 `<canvas>` + `toBlob('image/webp', quality)` 实现
- 全局开关 + 质量参数（0~1）
- **跨 provider 通用**，应放在 `imageHandler` 层而非 provider 内部

注意：SVG / GIF 应跳过；保留透明通道时优先 webp。

#### 5.3 重试机制
当前上传失败直接挂掉，瞬时网络抖动很常见。
- 实现 `uploadWithRetry(fn, retries=2, backoff=1000ms)`
- 401/403 不重试（鉴权错误重试无意义）
- 超时、5xx 算可重试
- 在 `imageHandler` 调用 provider 时统一包装，所有 provider 受益

#### 5.4 README 同步更新
重构后接口、配置项、命令、键位都变了，README 需同步。否则用户装上不会用。

---

### 🟡 中 ROI

#### 5.5 文件大小限制
当前不限制大小。用户拖入超大 PNG 会卡住编辑器（FileReader → base64 占用内存）。
- 加 `maxFileSizeMB` 设置（默认 10MB）
- 超限 Notice 拒绝并跳过，避免静默失败

#### 5.6 上传进度反馈
现在多图上传只显示"正在上传 N 张图片..."，看不出进度。
- `Notice` 显示 `已完成 3/5`
- 在 `Promise.allSettled` 包一层，每个 promise 完成时更新计数

#### 5.7 输出格式可选
现在固定输出 `![name](url)`。可选格式：
- HTML：`<img src="url" alt="name" width="500">`
- 带宽度：`![name|500](url)`（Obsidian 语法）
- 自定义模板，变量：`{name} {url}`

加一个"输出格式模板"全局设置即可。

#### 5.8 单元测试
当前 0 测试。最适合加单测的纯函数：
- `utf8ToBase64` / `urlSafeBase64Encode` / `base64ToUrlSafe`
- `generateFileName`（含 .gitignore 边界）
- `migrateSettings`（v1 / v2 / v3 三种迁移路径）
- `joinUrl`

引入 `vitest`，约半天工作量；后续 schema 升级有保障。

#### 5.9 日志可控
当前所有失败都 `console.error`。建议：
- 加 `debug` 设置项，关闭时只输出 warn 及以上
- 或集中到 `src/logger.ts`，统一前缀与级别

---

### 🔴 低 ROI（暂不推荐）

#### 5.10 国际化（i18n）
当前中文硬编码。仅当上架 Obsidian 社区插件市场时才需要做。

#### 5.11 详细网络诊断
对测试上传失败做 DNS/TCP/响应时间诊断。成本高，用户感知低。

#### 5.12 上传 Pipeline 化
把"日期归档 + 重命名 + 水印 + 压缩"做成可组合 pipeline。架构优雅但实际用不到，过度设计。

---

### 推进建议

如果后续继续投入，按以下顺序最划算：

1. **README 同步更新**（5.4）— 必做，否则重构成果用户用不上
2. **重试 + 文件大小限制**（5.3 + 5.5）— 防御性，避免 bad case 劝退用户
3. **图片压缩**（5.2）— 真实场景刚需，省流量省钱
4. **文件名模板**（5.1）— 老用户痛点，工作量小
5. **进度反馈**（5.6）— 体验细节
6. **单元测试**（5.8）— 长期质量保障

