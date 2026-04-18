import { registerProvider } from './registry';
import { qiniuProvider } from './qiniu';

/**
 * 内置 provider 注册入口
 *
 * 新增 provider 步骤：
 * 1. 在 src/providers/<your-provider>/ 下实现 ImageUploader
 * 2. 在此处 import 并 registerProvider
 */
let initialized = false;
export function initBuiltinProviders(): void {
  if (initialized) return;
  initialized = true;
  registerProvider(qiniuProvider);
  // 未来在此处追加：
  // registerProvider(aliyunOssProvider);
  // registerProvider(tencentCosProvider);
}

export * from './types';
export * from './registry';
