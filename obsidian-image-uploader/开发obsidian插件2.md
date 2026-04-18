# 开发 Obsidian 插件：七牛云图片上传

## 一、初始代码审查

### 1.1 项目结构

```
obsidian-image-uploader/
├── main.ts                 # 插件主入口
├── manifest.json           # 插件配置
├── package.json            # npm 配置
├── esbuild.config.mjs      # 构建配置
├── tsconfig.json           # TypeScript 配置
├── styles.css              # 样式文件
├── src/
│   ├── types.ts            # 类型定义
│   ├── settings.ts         # 设置面板
│   ├── imageHandler.ts     # 图片处理
│   └── qiniuUploader.ts    # 七牛云上传
```

### 1.2 发现的问题

#### 问题 1: main.ts 缺少 Notice 导入

**位置**: main.ts 第 1 行

**问题**: 使用了 `Notice` 但没有从 `obsidian` 导入

```typescript
// 错误代码
import { Plugin, MarkdownView, Editor } from 'obsidian';

// 后续代码使用了 Notice
new Notice(validationError);  // 第 60 行
new Notice('图片上传成功！');   // 第 68 行
new Notice('剪贴板中没有图片或上传失败'); // 第 72 行
```

**影响**: TypeScript 编译错误，运行时 ReferenceError

#### 问题 2: 剪贴板命令逻辑混乱

**位置**: main.ts 第 36-76 行

**问题**:
1. 创建了 `File` 对象后调用 `handlePaste`（无效，因为 `handlePaste` 需要真实的 `ClipboardEvent`）
2. 然后又重复验证设置并调用 `uploadToQiniu`
3. 代码冗余且逻辑不清晰

```typescript
// 问题代码
this.addCommand({
  id: 'upload-clipboard-image',
  name: '上传剪贴板图片到七牛云',
  callback: async () => {
    // ...获取剪贴板图片
    await this.imageHandler.handlePaste(
      new ClipboardEvent('paste', { clipboardData: new DataTransfer() }),
      editor,
      activeView
    );
    // 然后又重复验证和上传
    const validationError = this.validateSettings();
    // ...
    const url = await uploadToQiniu(this.settings, file, file.name);
  }
});
```

#### 问题 3: imageHandler.ts 方法可见性

**位置**: imageHandler.ts 第 56 行

**问题**: `uploadAndInsert` 是私有方法，无法被 `main.ts` 的命令调用

```typescript
private async uploadAndInsert(...)  // 私有方法
```

---

## 二、查询 PicGo-Core 七牛云实现

### 2.1 PicGo 项目结构

PicGo 应用使用 `picgo` npm 包作为核心上传库。从 GitHub 获取 PicGo-Core 的七牛云上传源码：

**源码地址**: https://raw.githubusercontent.com/PicGo/PicGo-Core/dev/src/plugins/uploader/qiniu.ts

### 2.2 PicGo-Core 七牛云上传逻辑

#### 上传方式: Base64 编码

```typescript
// 端点格式
const areaSuffix = area === 'z0' ? '' : '-' + area;
const url = `http://upload${areaSuffix}.qiniup.com/putb64/-1/key/${base64FileName}`;
```

- 华东(z0) → `http://upload.qiniup.com`
- 其他区域 → `http://upload-z1.qiniup.com` 等

#### Token 生成

```typescript
function getToken(qiniuOptions) {
  const flags = {
    scope: bucket,           // 只用 bucket，不包含 key
    deadline: 3600 + Math.floor(Date.now() / 1000)
  };
  const encodedFlags = urlSafeBase64Encode(JSON.stringify(flags));
  const encodedSign = base64ToUrlSafe(hmacSha1Base64(encodedFlags, secretKey));
  return `${accessKey}:${encodedSign}:${encodedFlags}`;
}
```

#### 文件名处理

```typescript
// PicGo-Core: Buffer.from(path + fileName, 'utf-8').toString('base64')
// 支持 UTF-8 字符（如中文路径）
const base64FileName = Buffer.from(path + fileName, 'utf-8')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');
```

### 2.3 与原实现的差异对比

| 方面 | PicGo-Core | 原 obsidian-image-uploader |
|------|-----------|------------------------|
| 上传方式 | Base64 (`putb64` API) | FormData (multipart) |
| 上传端点 | `http://upload${area}.qiniup.com` | `https://up.qiniup.com` (固定) |
| Token scope | 只用 `bucket` | `bucket:key` (指定 key) |
| 区域选择 | 动态拼接区域后缀 | 固定映射到不同域名 |
| UTF-8 支持 | Buffer.from(str, 'utf-8') | btoa() (不支持中文) |

---

## 三、按照 PicGo-Core 方式修改代码

### 3.1 修改 types.ts - 区域端点逻辑

**修改前**:
```typescript
export const QINIU_REGIONS: Record<string, { url: string; name: string }> = {
  'z0': { url: 'https://up.qiniup.com', name: '华东' },
  'z1': { url: 'https://up-z1.qiniup.com', name: '华北' },
  // ...
};

export function getUploadUrl(area: string): string {
  return QINIU_REGIONS[area]?.url || QINIU_REGIONS['z0'].url;
}
```

**修改后**:
```typescript
// 七牛云区域名称映射（用于设置界面下拉选择）
export const QINIU_REGIONS: Record<string, string> = {
  'z0': '华东',
  'z1': '华北',
  'z2': '华南',
  'na0': '北美',
  'as0': '东南亚',
};

// 七牛云区域上传端点（Base64 上传方式）
// 华东(z0) 使用 upload.qiniup.com，其他区域使用 upload-${area}.qiniup.com
export function getUploadUrl(area: string): string {
  const areaSuffix = area === 'z0' ? '' : `-${area}`;
  return `http://upload${areaSuffix}.qiniup.com`;
}
```

### 3.2 修改 qiniuUploader.ts - Base64 上传方式

**主要改动**:

1. **添加 UTF-8 Base64 编码函数**:
```typescript
/**
 * UTF-8 字符串转 Base64 (参考 PicGo-Core)
 * btoa() 只支持 Latin1，需要先用 TextEncoder 处理 UTF-8
 */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
  return btoa(binary);
}

function base64ToUrlSafe(value: string): string {
  return value.replace(/\//g, '_').replace(/\+/g, '-');
}

function urlSafeBase64Encode(value: string): string {
  return base64ToUrlSafe(utf8ToBase64(value));
}
```

2. **修改 Token 生成**:
```typescript
async function getToken(config: QiniuConfig): Promise<string> {
  const flags = {
    scope: config.bucket,  // 只用 bucket
    deadline: 3600 + Math.floor(Date.now() / 1000)
  };
  const encodedFlags = urlSafeBase64Encode(JSON.stringify(flags));
  const encodedSign = base64ToUrlSafe(await hmacSha1Base64(secretKey, encodedFlags));
  return `${accessKey}:${encodedSign}:${encodedFlags}`;
}
```

3. **修改上传实现**:
```typescript
export async function uploadToQiniu(config, file, fileName) {
  const uploadUrl = getUploadUrl(config.area);
  const key = generateFileName(config, fileName);
  const token = await getToken(config);

  // 文件转 Base64
  const arrayBuffer = await file.arrayBuffer();
  const imgBase64 = btoa(Array.from(new Uint8Array(arrayBuffer))
    .map(b => String.fromCharCode(b)).join(''));

  // 文件名 URL-safe Base64 编码 (支持 UTF-8)
  const base64FileName = base64ToUrlSafe(utf8ToBase64(key));

  // Base64 上传 URL
  const url = `${uploadUrl}/putb64/-1/key/${base64FileName}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `UpToken ${token}`,
      'Content-Type': getMimeType(fileName)
    },
    body: imgBase64
  });
  // ...
}
```

### 3.3 修改 settings.ts - 区域映射

```typescript
// 修改前
Object.entries(QINIU_REGIONS).forEach(([code, info]) => {
  dropdown.addOption(code, `${info.name} (${code})`);
});

// 修改后
Object.entries(QINIU_REGIONS).forEach(([code, name]) => {
  dropdown.addOption(code, `${name} (${code})`);
});
```

### 3.4 修复 main.ts - Notice 导入

```typescript
// 修改前
import { Plugin, MarkdownView, Editor } from 'obsidian';

// 修改后
import { Plugin, MarkdownView, Editor, Notice } from 'obsidian';
```

---

## 四、编译验证

```bash
cd obsidian-image-uploader
npm run build
```

编译成功，无错误。

---

## 五、二次检查发现的额外问题

### 5.1 UTF-8 文件名编码问题

**位置**: qiniuUploader.ts 第 132 行（原）

**问题**: `btoa()` 只能处理 Latin1 字符，中文路径会报错

```typescript
// 问题代码
const base64FileName = btoa(key)  // 不支持 UTF-8
  .replace(/\+/g, '-')
  .replace(/\//g, '_');
```

**修复**: 参考 PicGo-Core 使用 UTF-8 编码

```typescript
// 修复后
const base64FileName = base64ToUrlSafe(utf8ToBase64(key));
```

---

## 六、重构剪贴板命令逻辑

### 6.1 修改 imageHandler.ts

```typescript
// 修改前
private async uploadAndInsert(...)

// 修改后
async uploadAndInsert(...)  // 改为 public
```

### 6.2 重构 main.ts 命令

**修改前**（冗余逻辑）:
```typescript
this.addCommand({
  callback: async () => {
    // 无效的 handlePaste 调用
    await this.imageHandler.handlePaste(...);
    // 重复验证
    const validationError = this.validateSettings();
    // 重复上传逻辑
    const url = await uploadToQiniu(...);
  }
});
```

**修改后**（简洁清晰）:
```typescript
this.addCommand({
  id: 'upload-clipboard-image',
  name: '上传剪贴板图片到七牛云',
  callback: async () => {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      new Notice('请先打开一个 Markdown 文件');
      return;
    }

    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageTypes = item.types.filter(t => t.startsWith('image/'));
        if (imageTypes.length > 0) {
          const blob = await item.getType(imageTypes[0]);
          const file = new File([blob], 'clipboard-image.png', { type: imageTypes[0] });
          await this.imageHandler.uploadAndInsert(file, activeView.editor, file.name);
          return;
        }
      }
      new Notice('剪贴板中没有图片');
    } catch (error) {
      new Notice('读取剪贴板失败或上传失败');
    }
  }
});
```

### 6.3 删除无用代码

删除 `main.ts` 中冗余的 `validateSettings` 私有方法（该功能已在 `imageHandler.ts` 中实现）。

---

## 七、更新 README 文档

主要更新内容：

1. 新增功能说明：命令上传、测试上传
2. 新增配置项：启用上传开关
3. 新增三种使用方式说明
4. 更新区域端点为 Base64 上传端点
5. 新增文件命名规则说明
6. 新增 UTF-8 支持说明
7. 新增技术实现说明（参考 PicGo-Core）

---

## 八、最终文件清单

修改的文件：
- `src/types.ts` - 区域端点逻辑
- `src/qiniuUploader.ts` - Base64 上传实现、UTF-8 支持
- `src/settings.ts` - 区域下拉框映射
- `src/imageHandler.ts` - uploadAndInsert 方法可见性
- `main.ts` - Notice 导入、剪贴板命令重构
- `README.md` - 文档更新

---

## 九、总结

本次开发遵循以下原则：

1. **参考成熟实现**: 以 PicGo-Core 的七牛云上传逻辑为基准
2. **代码简洁**: 消除冗余逻辑，复用现有方法
3. **兼容性**: 支持 UTF-8 字符（中文路径等）
4. **文档完善**: 更新 README 说明所有功能和配置