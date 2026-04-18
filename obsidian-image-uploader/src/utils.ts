/**
 * 共享工具：图片扩展名 / MIME / 错误信息 / 远程链接判断 / markdown & wikilink 正则
 *
 * 这里集中定义，避免 main / imageHandler / providers 之间出现重复且易于不一致的常量。
 */

/** 支持的本地图片扩展名 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'tif', 'tiff',
]);

const EXT_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export function extToMime(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] || 'application/octet-stream';
}

export function getMimeByFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return extToMime(fileName.slice(dot + 1));
}

/** 判断是否为图片扩展名 */
export function isImageExt(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/** 提取错误信息（类型守卫） */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 判断链接是否为远程 / 数据 URI */
export function isRemoteLink(link: string): boolean {
  const lower = link.trim().toLowerCase();
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('//') ||
    lower.startsWith('data:')
  );
}

/**
 * 标准 markdown 图片语法 ![alt](url "title") —— 标题/属性可选
 *
 * 注意：
 * - url 部分用 `[^)]+` 而不是 `[^)\s]+`，以兼容含空格的本地路径（Obsidian 允许）。
 * - 由于 g 标志对象会被多个调用复用并修改 lastIndex，请勿直接 export 单例；
 *   而是通过下面的工厂函数每次创建新对象。
 */
export function createMdImageRegex(): RegExp {
  return /!\[([^\]]*)\]\(([^)]+?)(?:\s+"([^"]*)")?\)/g;
}

/**
 * Obsidian wikilink 嵌入图片 ![[link|alias]]
 *  - link 部分允许包含空格、子目录
 *  - alias / 显示尺寸（如 ![[image.png|200]]）作为可选第二段
 */
export function createWikiImageRegex(): RegExp {
  return /!\[\[([^\]\|\n]+?)(?:\|([^\]\n]*))?\]\]/g;
}

/**
 * 判断本地图片链接：
 *  - 排除远程 / data
 *  - 解析 URL 编码
 *  - 仅当后缀在白名单内
 */
export function isLocalImageLink(link: string): boolean {
  if (!link || isRemoteLink(link)) return false;
  let path: string;
  try {
    path = decodeURIComponent(link.split('#')[0].split('?')[0]);
  } catch {
    path = link.split('#')[0].split('?')[0];
  }
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return isImageExt(path.slice(dot + 1));
}
