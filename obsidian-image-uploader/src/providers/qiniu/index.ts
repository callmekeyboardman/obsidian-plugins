import { ImageUploader, ProviderField } from '../types';
import {
  QiniuConfig,
  DEFAULT_QINIU_CONFIG,
  QINIU_REGIONS,
} from './types';
import { uploadToQiniu, clearTokenCache } from './uploader';

const QINIU_FIELDS: ReadonlyArray<ProviderField> = [
  {
    key: 'accessKey',
    name: 'Access Key',
    desc: '七牛云 Access Key (从七牛云控制台获取)',
    type: 'password',
    placeholder: '请输入 Access Key',
    required: true,
  },
  {
    key: 'secretKey',
    name: 'Secret Key',
    desc: '七牛云 Secret Key (从七牛云控制台获取)',
    type: 'password',
    placeholder: '请输入 Secret Key',
    required: true,
  },
  {
    key: 'bucket',
    name: '存储空间 (Bucket)',
    desc: '七牛云存储空间名称',
    type: 'text',
    placeholder: '请输入 Bucket 名称',
    required: true,
  },
  {
    key: 'url',
    name: '访问域名 (URL)',
    desc: '存储空间的访问域名，需包含 http:// 或 https:// 前缀',
    type: 'text',
    placeholder: 'https://your-domain.com',
    required: true,
  },
  {
    key: 'area',
    name: '存储区域',
    desc: '选择存储空间所在的区域',
    type: 'dropdown',
    options: QINIU_REGIONS,
    required: true,
  },
  {
    key: 'path',
    name: '存储路径',
    desc: '可选的存储路径前缀，如 images/ 或 obsidian/',
    type: 'text',
    placeholder: 'images/',
  },
  {
    key: 'options',
    name: 'URL 后缀',
    desc: '可选的 URL 后缀，用于图片处理样式，如 ?imageView2/0',
    type: 'text',
    placeholder: '?imageView2/0',
  },
];

export const qiniuProvider: ImageUploader<QiniuConfig> = {
  id: 'qiniu',
  name: '七牛云',
  fields: QINIU_FIELDS,

  defaultConfig(): QiniuConfig {
    return { ...DEFAULT_QINIU_CONFIG };
  },

  validate(config: QiniuConfig): string | null {
    const required: Array<[keyof QiniuConfig, string]> = [
      ['accessKey', 'Access Key'],
      ['secretKey', 'Secret Key'],
      ['bucket', '存储空间 (Bucket)'],
      ['url', '访问域名 (URL)'],
      ['area', '存储区域'],
    ];
    for (const [field, name] of required) {
      if (!config[field]) {
        return `请先在设置中填写 ${name}`;
      }
    }
    if (!config.url.startsWith('http://') && !config.url.startsWith('https://')) {
      return '访问域名需要包含 http:// 或 https:// 前缀';
    }
    return null;
  },

  async upload(config, file, fileName, timeoutMs) {
    const url = await uploadToQiniu(config, file, fileName, timeoutMs);
    return { url };
  },

  clearCache() {
    clearTokenCache();
  },
};

// 重新导出，方便外部需要时使用
export type { QiniuConfig };
export { DEFAULT_QINIU_CONFIG, QINIU_REGIONS };
