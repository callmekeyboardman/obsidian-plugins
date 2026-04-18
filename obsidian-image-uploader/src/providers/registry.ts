import { ImageUploader } from './types';

/**
 * 全局 Provider 注册表
 *
 * 内置 provider 在 src/providers/index.ts 中调用 registerProvider 注册；
 * 未来若支持外部扩展，也可通过此 API 注入。
 */
const registry = new Map<string, ImageUploader>();

export function registerProvider(p: ImageUploader): void {
  if (registry.has(p.id)) {
    console.warn(`[ImageUploader] Provider "${p.id}" already registered, overwriting`);
  }
  registry.set(p.id, p);
}

export function getProvider(id: string): ImageUploader | undefined {
  return registry.get(id);
}

export function listProviders(): ImageUploader[] {
  return [...registry.values()];
}

/**
 * 获取所有 provider 的 [id, name] 映射，用于设置面板下拉
 */
export function getProviderOptions(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const p of registry.values()) {
    result[p.id] = p.name;
  }
  return result;
}
