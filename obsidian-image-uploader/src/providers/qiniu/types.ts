/**
 * 七牛云相关类型与常量
 */

export interface QiniuConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  url: string;        // 访问域名，需 http:// 或 https:// 前缀
  area: string;       // 区域代码: z0, z1, z2, na0, as0
  options: string;    // 可选 URL 后缀 (如 ?imageView2/0)
  path: string;       // 可选存储路径前缀
}

export const QINIU_REGIONS: Record<string, string> = {
  'z0': '华东 (z0)',
  'z1': '华北 (z1)',
  'z2': '华南 (z2)',
  'na0': '北美 (na0)',
  'as0': '东南亚 (as0)',
};

/**
 * 七牛云区域上传端点（Base64 上传方式，强制 HTTPS）
 * 华东(z0) 使用 upload.qiniup.com，其他区域使用 upload-${area}.qiniup.com
 */
export function getUploadUrl(area: string): string {
  const areaSuffix = area === 'z0' ? '' : `-${area}`;
  return `https://upload${areaSuffix}.qiniup.com`;
}

export interface QiniuUploadResponse {
  hash: string;
  key: string;
}

export const DEFAULT_QINIU_CONFIG: QiniuConfig = {
  accessKey: '',
  secretKey: '',
  bucket: '',
  url: '',
  area: 'z0',
  options: '',
  path: '',
};
