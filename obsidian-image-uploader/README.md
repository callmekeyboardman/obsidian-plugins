# Image Uploader for Obsidian

一个 Obsidian 图床插件：支持将粘贴/拖入的图片自动上传到云存储，并在编辑器中插入 Markdown 链接。

> 当前内置 **七牛云** provider；架构上已抽象为可扩展的 Provider 模型，后续将增加阿里云 OSS、腾讯云 COS 等图床。

---

## ✨ 功能

- 🖼️ **粘贴上传** — Ctrl/Cmd + V 粘贴图片即自动上传
- 📁 **拖放上传** — 把本地图片拖入编辑器即自动上传
- 📋 **命令上传** — 命令面板手动触发剪贴板图片上传
- ⚙️ **可扩展架构** — Provider 抽象，新增图床无需改主流程
- 🧪 **测试上传** — 设置面板一键验证配置
- 🔗 **自动插入** — 上传成功后自动替换占位符为最终 Markdown 链接
- 🛡️ **健壮性** — 上传超时控制、Token 缓存、401/403 自动失效
- 🔄 **向后兼容** — 旧版配置自动迁移到新结构

---

## 📦 安装

### 手动安装

1. 下载 `main.js`、`manifest.json`、`styles.css`
2. 在 vault 中创建目录：`.obsidian/plugins/qiniu-image-uploader/`
3. 把上面三个文件复制进去
4. 重启 Obsidian
5. 在 **设置 → 第三方插件** 中启用本插件

### 从源码构建

```bash
git clone <repo>
cd obsidian-image-uploader
npm install
npm run build      # 生产构建
# npm run dev      # 开发模式（监听变更）
```

---

## 🚀 使用方式

### 1. 粘贴上传

在编辑器中粘贴图片（Ctrl/Cmd + V）即可，图片会上传后自动替换为 `![filename](url)`。

> ⚠️ 若剪贴板**同时包含文本**（如从浏览器复制图文混排），插件会**跳过本次自动上传**，由 Obsidian 处理默认粘贴行为，避免吞掉文本内容。此时如需仅上传图片，请使用方式 3。

### 2. 拖放上传

把本地图片文件拖入编辑器，自动上传并插入链接。

### 3. 命令上传

1. 打开命令面板（Ctrl/Cmd + P）
2. 搜索并执行「上传剪贴板图片」
3. 当前剪贴板里的图片会上传并插入到光标位置

> 多图同时上传时，编辑器会先插入唯一占位符，上传完成后逐一替换为真实链接，不会阻塞编辑。

---

## ⚙️ 配置

设置面板分为 **通用配置** 与 **图床配置** 两部分。

### 通用配置

| 配置项 | 说明 | 默认 |
|---|---|---|
| **启用上传** | 开启/关闭自动粘贴/拖放上传 | 开启 |
| **图床** | 选择当前生效的图床 provider | 七牛云 |
| **上传超时（秒）** | 单次上传最长等待时间 | 30 |

切换图床时，**各 provider 的配置会独立保存**，切回时无需重新填写。

### 七牛云配置

| 配置项 | 说明 | 必填 |
|---|---|---|
| **Access Key** | 七牛云 AK（控制台获取） | ✅ |
| **Secret Key** | 七牛云 SK（控制台获取） | ✅ |
| **存储空间 (Bucket)** | 存储空间名称 | ✅ |
| **访问域名 (URL)** | 绑定的访问域名，必须含 `http://` 或 `https://` | ✅ |
| **存储区域** | 华东 / 华北 / 华南 / 北美 / 东南亚 | ✅ |
| **存储路径** | 可选路径前缀，如 `images/`、`obsidian/` | — |
| **URL 后缀** | 可选 URL 后缀，用于图片处理样式，如 `?imageView2/0` | — |

设置完成后点击 **测试上传** 按钮，可使用一张 1x1 透明 PNG 验证配置是否正确。

### 七牛区域端点

| 区域代码 | 区域名称 | 上传端点 |
|---|---|---|
| `z0` | 华东 | `https://upload.qiniup.com` |
| `z1` | 华北 | `https://upload-z1.qiniup.com` |
| `z2` | 华南 | `https://upload-z2.qiniup.com` |
| `na0` | 北美 | `https://upload-na0.qiniup.com` |
| `as0` | 东南亚 | `https://upload-as0.qiniup.com` |

> 全部使用 HTTPS 端点，避免 Token 在公网明文传输。

---

## 📝 文件命名规则

七牛云 provider 当前使用如下命名（暂不可配，后续将开放模板）：

```
{路径前缀}{时间戳}{6位随机字符}.{扩展名}
```

示例：
- 无路径前缀：`1716281234567abc12.png`
- 路径前缀 `obsidian/`：`obsidian/1716281234567abc12.png`

支持中文及 UTF-8 文件名（采用 URL-safe Base64 编码）。

---

## 🔐 安全提示

- **AK / SK 以明文存储在** `.obsidian/plugins/qiniu-image-uploader/data.json`
- 若用 Git 同步 vault，请将该文件加入 `.gitignore`
- 若使用 Obsidian Sync / 第三方云同步，请评估其加密能力
- 建议在七牛云控制台为该 Bucket 创建**独立子账号密钥**，仅授予 `upload` 权限

---

## 🧩 架构（开发者向）

本插件采用 **Provider 抽象** 架构，设置面板根据 provider 字段元数据自动渲染。

```
src/
├── providers/
│   ├── types.ts        # ImageUploader / ProviderField / UploadResult
│   ├── registry.ts     # 全局 provider 注册表
│   ├── index.ts        # initBuiltinProviders + 统一导出
│   └── qiniu/          # 七牛云实现
│       ├── types.ts
│       ├── uploader.ts
│       └── index.ts    # qiniuProvider: ImageUploader<QiniuConfig>
├── imageHandler.ts     # 粘贴/拖放/命令上传，与厂商完全解耦
├── settings.ts         # 根据 provider.fields 动态渲染设置面板
└── types.ts            # PluginSettings + 三段式向后兼容迁移
main.ts                 # 入口：注册 provider、绑定事件、命令、设置
```

### 新增图床步骤示例

1. 新建 `src/providers/<your-provider>/{types,uploader,index}.ts`
2. 实现 `ImageUploader<TConfig>` 接口，声明 `fields` 元数据
3. 在 `src/providers/index.ts` 的 `initBuiltinProviders()` 追加 `registerProvider(yourProvider)`
4. 完成 — 设置面板、配置存储、迁移逻辑全部自动适配

详细设计见 [`开发obsidian插件4.md`](./开发obsidian插件4.md) 第四章。

### 兼容性

`migrateSettings` 自动识别三种历史结构：

- **v1**：扁平 `{ enabled, accessKey, secretKey, ... }`
- **v2**：`{ enabled, qiniu: {...} }`
- **v3** 当前：`{ enabled, activeProvider, providers: { qiniu: {...} } }`

升级用户无需手动迁移配置。

---

## 🔧 技术细节

- 七牛上传走 **`putb64` Base64 上传**，避免处理 multipart/form-data
- Token 使用 **HMAC-SHA1** 签名（Web Crypto API），按 `accessKey:bucket` 缓存 1 小时
- 401/403 时自动清除对应 Token 缓存，下次重新申请
- 大文件用 **FileReader** 流式转 base64，避免栈溢出
- 上传支持 **超时取消**（`AbortController`，`signal.aborted` 跨运行时一致）
- 多图并发上传，按顺序替换唯一占位符，不阻塞编辑

---

## 🗺️ Roadmap

参见 [`开发obsidian插件4.md`](./开发obsidian插件4.md) 第五章「后续优化清单」，主要包括：

- [ ] 文件名模板可配置
- [ ] 上传前压缩 / 转 webp
- [ ] 失败自动重试
- [ ] 大文件大小限制
- [ ] 上传进度反馈
- [ ] 输出格式可选（HTML / Wikilink / 带宽度参数）
- [ ] 单元测试
- [ ] 阿里云 OSS / 腾讯云 COS provider

---

## 📄 License

MIT
