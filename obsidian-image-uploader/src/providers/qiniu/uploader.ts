import { requestUrl, RequestUrlResponse } from 'obsidian';
import { QiniuConfig, QiniuUploadResponse, getUploadUrl } from './types';
import { getMimeByFileName } from '../../utils';

/**
 * UTF-8 字符串转 Base64 (参考 PicGo-Core)
 * btoa() 只支持 Latin1，需要先用 TextEncoder 处理 UTF-8
 */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Base64 URL-safe 编码 (参考 PicGo-Core)
 * 替换 '+' 为 '-', '/' 为 '_'
 */
function base64ToUrlSafe(value: string): string {
  return value.replace(/\//g, '_').replace(/\+/g, '-');
}

/**
 * Base64 URL-safe 编码字符串 (支持 UTF-8)
 */
function urlSafeBase64Encode(value: string): string {
  return base64ToUrlSafe(utf8ToBase64(value));
}

/**
 * HMAC-SHA1 签名 (使用 Web Crypto API)
 */
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
  const view = new Uint8Array(signature);
  let binary = '';
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
}

/**
 * Token 缓存：key = accessKey:bucket，避免每次上传都重算签名
 */
interface CachedToken {
  token: string;
  expiresAt: number; // 秒级时间戳
}
const tokenCache = new Map<string, CachedToken>();
const TOKEN_TTL_SECONDS = 3600;       // Token 有效期 1 小时
const TOKEN_REFRESH_BUFFER = 5 * 60;  // 提前 5 分钟刷新

/**
 * 生成七牛云上传 Token (带缓存)
 * Token 格式: accessKey:encodedSignature:encodedPolicy
 */
async function getToken(config: QiniuConfig): Promise<string> {
  const cacheKey = `${config.accessKey}:${config.bucket}`;
  const nowSec = Math.floor(Date.now() / 1000);

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REFRESH_BUFFER > nowSec) {
    return cached.token;
  }

  const deadline = nowSec + TOKEN_TTL_SECONDS;
  const flags = {
    scope: config.bucket,
    deadline,
  };

  const encodedFlags = urlSafeBase64Encode(JSON.stringify(flags));
  const encodedSign = base64ToUrlSafe(await hmacSha1Base64(config.secretKey, encodedFlags));
  const token = `${config.accessKey}:${encodedSign}:${encodedFlags}`;

  tokenCache.set(cacheKey, { token, expiresAt: deadline });
  return token;
}

/**
 * 清除 Token 缓存（设置变更或卸载时调用）
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * 规范化路径前缀：确保以 '/' 结尾（若非空）
 */
function normalizePath(path: string): string {
  if (!path) return '';
  return path.endsWith('/') ? path : path + '/';
}

/**
 * 生成唯一文件名（修复 .gitignore 等边界情况）
 */
function generateFileName(config: QiniuConfig, originalFileName: string): string {
  const timestamp = Date.now();
  // 优先 crypto.randomUUID，兜底 Math.random
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const randomStr = cryptoObj?.randomUUID
    ? cryptoObj.randomUUID().replace(/-/g, '').slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

  // 仅当 '.' 不是首字符时才视为扩展名分隔符
  const dotIdx = originalFileName.lastIndexOf('.');
  const ext = dotIdx > 0 ? originalFileName.substring(dotIdx) : '';

  const baseName = `${timestamp}${randomStr}${ext}`;
  const prefix = normalizePath(config.path);
  return `${prefix}${baseName}`;
}

/**
 * 通过 FileReader 高效将 Blob 读为 ArrayBuffer
 * 用于构造 multipart 上传 body（避免 base64 膨胀 ~33%）
 */
function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (!(result instanceof ArrayBuffer)) {
        reject(new Error('FileReader 返回类型异常'));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * 拼接最终访问 URL，去除多余斜杠
 */
function joinUrl(baseUrl: string, key: string, suffix: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedKey = key.replace(/^\/+/, '');
  return `${trimmedBase}/${trimmedKey}${suffix || ''}`;
}

/**
 * 带超时的 requestUrl
 *
 * 使用 Obsidian 官方 requestUrl 接口（请求经由 Electron 主进程发起，绕过浏览器 CORS），
 * 这是社区插件调用第三方 HTTP API 的标准做法。注意：requestUrl 不支持 AbortController，
 * 因此用 Promise.race 实现超时（超时后底层请求仍会继续完成，但调用方已不再等待）。
 */
async function requestWithTimeout(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string | ArrayBuffer;
  },
  timeoutMs: number
): Promise<RequestUrlResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`上传超时（${timeoutMs}ms）`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([
      requestUrl({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
        // 自行处理状态码，避免 4xx/5xx 抛出无法读取响应体的异常
        throw: false,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 单次上传请求（不含重试逻辑）
 *
 * 使用 multipart/form-data 走 /（普通上传）端点，避免 base64 通道在中等
 * 大小文件（>1MB）下出现 ERR_CONNECTION_RESET。
 */
async function doUpload(
  uploadUrl: string,
  token: string,
  key: string,
  fileName: string,
  contentType: string,
  fileBuffer: ArrayBuffer,
  timeoutMs: number
): Promise<RequestUrlResponse> {
  const boundary = `----QiniuFormBoundary${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const body = buildMultipartBody(boundary, [
    { name: 'key', value: key },
    { name: 'token', value: token },
    {
      name: 'file',
      filename: fileName,
      contentType,
      value: fileBuffer,
    },
  ]);

  return requestWithTimeout(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Accept': 'application/json',
      },
      body,
    },
    timeoutMs
  );
}

/**
 * 构造 multipart/form-data 请求体（返回 ArrayBuffer）
 *
 * 字段顺序与七牛官方表单上传约定一致：先 key、token，最后 file。
 */
type MultipartField =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; value: ArrayBuffer };

function buildMultipartBody(boundary: string, fields: MultipartField[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const CRLF = '\r\n';

  for (const field of fields) {
    parts.push(encoder.encode(`--${boundary}${CRLF}`));
    if ('filename' in field) {
      parts.push(
        encoder.encode(
          `Content-Disposition: form-data; name="${field.name}"; filename="${escapeQuotes(field.filename)}"${CRLF}` +
            `Content-Type: ${field.contentType}${CRLF}${CRLF}`
        )
      );
      parts.push(new Uint8Array(field.value));
      parts.push(encoder.encode(CRLF));
    } else {
      parts.push(
        encoder.encode(
          `Content-Disposition: form-data; name="${field.name}"${CRLF}${CRLF}${field.value}${CRLF}`
        )
      );
    }
  }
  parts.push(encoder.encode(`--${boundary}--${CRLF}`));

  // 拼接所有 part 到一个连续 ArrayBuffer
  const totalLen = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.byteLength;
  }
  return result.buffer;
}

function escapeQuotes(s: string): string {
  return s.replace(/"/g, '%22');
}

/**
 * 上传文件到七牛云（multipart/form-data 表单上传，HTTPS）
 *
 * 端点: https://upload{area}.qiniup.com/  （根路径）
 *
 * 选用 multipart 而非 base64 通道（putb64）的原因：
 * - base64 编码会让 body 膨胀 ~33%，超过 1MB 的图片极易触发服务端连接重置（ERR_CONNECTION_RESET）
 * - multipart 是七牛官方推荐的标准上传方式，支持到 GB 级
 *
 * 错误处理：遇到 401/403（token 失效）会清除缓存并自动重试一次。
 */
export async function uploadToQiniu(
  config: QiniuConfig,
  file: File | Blob,
  fileName: string,
  timeoutMs: number = 30_000
): Promise<string> {
  const uploadUrl = getUploadUrl(config.area);
  const key = generateFileName(config, fileName);
  const cacheKey = `${config.accessKey}:${config.bucket}`;

  // 直接读为 ArrayBuffer，避免 base64 膨胀
  const fileBuffer = await blobToArrayBuffer(file);

  // 优先使用 File/Blob 自带的 type，扩展名作为兜底
  const blobType = (file as { type?: string }).type;
  const contentType = blobType || getMimeByFileName(fileName);

  const send = async (): Promise<RequestUrlResponse> => {
    const token = await getToken(config);
    return doUpload(uploadUrl, token, key, fileName, contentType, fileBuffer, timeoutMs);
  };

  let response = await send();

  // 401/403：token 可能失效，清缓存后重试一次
  if (response.status === 401 || response.status === 403) {
    tokenCache.delete(cacheKey);
    response = await send();
  }

  // requestUrl 设了 throw:false，由我们自己判定状态码
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 401 || response.status === 403) {
      tokenCache.delete(cacheKey);
    }
    const errorText = response.text || '';
    throw new Error(`上传失败: ${response.status} - ${errorText}`);
  }

  const result = response.json as unknown as QiniuUploadResponse;
  return joinUrl(config.url, result.key, config.options);
}
