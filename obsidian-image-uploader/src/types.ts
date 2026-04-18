import { getProvider, listProviders } from './providers';

/**
 * 插件设置
 *
 * 设计：
 * - activeProvider 指定当前生效的图床
 * - providers 是一个 map，每个 provider 各自存储一份配置（key 为 provider.id）
 *   这样切换图床时不会丢失上一个的配置
 */
/**
 * 本地图片上传成功后对原文件的处理策略
 *  - keep:   保留本地文件（默认，最安全）
 *  - trash:  调用 Vault.trash() 移到 Obsidian 回收站（系统回收站若不可用则 vault 内 .trash）
 *  - delete: 永久删除
 */
export type LocalFileAction = 'keep' | 'trash' | 'delete';

export interface PluginSettings {
  enabled: boolean;
  uploadTimeoutMs: number;
  activeProvider: string;
  providers: Record<string, unknown>;
  /** 右键上传本地图片成功后，对原文件的处理方式 */
  localFileAction: LocalFileAction;
}

const DEFAULT_PROVIDER_ID = 'qiniu';

/**
 * 默认设置：自动用所有已注册 provider 的 defaultConfig 初始化 providers map
 *
 * 注意：调用此函数前需保证 initBuiltinProviders() 已执行
 */
export function buildDefaultSettings(): PluginSettings {
  const providers: Record<string, unknown> = {};
  for (const p of listProviders()) {
    providers[p.id] = p.defaultConfig();
  }
  return {
    enabled: true,
    uploadTimeoutMs: 30_000,
    activeProvider: DEFAULT_PROVIDER_ID,
    providers,
    localFileAction: 'keep',
  };
}

/**
 * 旧版 v1 扁平结构（PluginSettings v1）：
 *   { enabled, accessKey, secretKey, bucket, url, area, options, path }
 *
 * 旧版 v2 结构：
 *   { enabled, uploadTimeoutMs, qiniu: {...} }
 *
 * 新版 v3 结构：
 *   { enabled, uploadTimeoutMs, activeProvider, providers: { qiniu: {...}, ... } }
 */
type LegacyV1 = {
  enabled?: boolean;
  accessKey?: string;
  secretKey?: string;
  bucket?: string;
  url?: string;
  area?: string;
  options?: string;
  path?: string;
};

interface LegacyV2 {
  enabled?: boolean;
  uploadTimeoutMs?: number;
  qiniu?: Record<string, unknown>;
}

interface CurrentV3 {
  enabled?: boolean;
  uploadTimeoutMs?: number;
  activeProvider?: string;
  providers?: Record<string, unknown>;
  localFileAction?: LocalFileAction;
}

/**
 * 设置迁移：兼容历史结构
 *
 * v3 (current)：原样 + 字段补齐
 * v2 → v3：把 qiniu 字段挪到 providers.qiniu，activeProvider 设为 'qiniu'
 * v1 → v3：把扁平字段聚合成 qiniu 配置，再走 v2 → v3 路径
 */
export function migrateSettings(raw: unknown): PluginSettings {
  const defaults = buildDefaultSettings();
  if (!raw || typeof raw !== 'object') return defaults;

  const data = raw as Record<string, unknown>;

  // v3: 已有 providers 字段
  if ('providers' in data && data.providers && typeof data.providers === 'object') {
    return mergeV3(data as CurrentV3, defaults);
  }

  // v2: 有 qiniu 字段
  if ('qiniu' in data && data.qiniu && typeof data.qiniu === 'object') {
    const v2 = data as LegacyV2;
    const upgraded: CurrentV3 = {
      enabled: v2.enabled,
      uploadTimeoutMs: v2.uploadTimeoutMs,
      activeProvider: 'qiniu',
      providers: { qiniu: v2.qiniu },
    };
    return mergeV3(upgraded, defaults);
  }

  // v1: 扁平结构，假设是七牛配置
  const v1 = data as LegacyV1;
  const qiniuConfig = {
    accessKey: v1.accessKey ?? '',
    secretKey: v1.secretKey ?? '',
    bucket: v1.bucket ?? '',
    url: v1.url ?? '',
    area: v1.area ?? 'z0',
    options: v1.options ?? '',
    path: v1.path ?? '',
  };
  const upgraded: CurrentV3 = {
    enabled: v1.enabled,
    activeProvider: 'qiniu',
    providers: { qiniu: qiniuConfig },
  };
  return mergeV3(upgraded, defaults);
}

/**
 * 合并 v3 数据与默认值；对每个已知 provider 进行字段补齐
 */
function mergeV3(data: CurrentV3, defaults: PluginSettings): PluginSettings {
  const providers: Record<string, unknown> = { ...defaults.providers };

  // 用持久化数据覆盖各 provider 配置（保留默认值字段）
  if (data.providers) {
    for (const [id, savedCfg] of Object.entries(data.providers)) {
      const provider = getProvider(id);
      if (provider) {
        // 已注册：以默认值为基准，叠加保存的字段（防止新增字段缺失）
        providers[id] = { ...(provider.defaultConfig() as object), ...(savedCfg as object) };
      } else {
        // 未注册的 provider：原样保留，便于将来加载该 provider 时恢复
        providers[id] = savedCfg;
      }
    }
  }

  const activeProvider =
    typeof data.activeProvider === 'string' && data.activeProvider
      ? data.activeProvider
      : defaults.activeProvider;

  const localFileAction: LocalFileAction =
    data.localFileAction === 'trash' || data.localFileAction === 'delete' || data.localFileAction === 'keep'
      ? data.localFileAction
      : defaults.localFileAction;

  return {
    enabled: typeof data.enabled === 'boolean' ? data.enabled : defaults.enabled,
    uploadTimeoutMs:
      typeof data.uploadTimeoutMs === 'number' && data.uploadTimeoutMs > 0
        ? data.uploadTimeoutMs
        : defaults.uploadTimeoutMs,
    activeProvider,
    providers,
    localFileAction,
  };
}

/**
 * 浅比较两份持久化数据是否等价（用于决定是否需要回写磁盘）。
 *
 * 用 JSON.stringify 做结构化比较；对小型设置对象代价可忽略。
 * 不依赖键顺序：先归一化为排序后的字符串。
 */
export function settingsEqual(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}
