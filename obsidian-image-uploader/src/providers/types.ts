/**
 * 图床 Provider 抽象层
 *
 * 设计目标：
 * - 新增图床（阿里云 OSS / 腾讯云 COS / S3 等）只需实现 ImageUploader 接口并注册
 * - 设置面板根据 fields 元数据自动渲染，无需为每种图床写 UI 代码
 * - PluginSettings 通过 providers map 支持多套配置共存
 */

/** 上传成功的返回 */
export interface UploadResult {
  url: string;
}

/** 单个配置字段的元数据，用于驱动设置面板自动渲染 */
export interface ProviderField {
  /** 配置键名（对应 config 对象的属性名） */
  key: string;
  /** 显示名 */
  name: string;
  /** 描述 */
  desc?: string;
  /** 输入类型 */
  type: 'text' | 'password' | 'number' | 'dropdown';
  /** dropdown 时使用：value -> label 的映射 */
  options?: Record<string, string>;
  /** 占位符 */
  placeholder?: string;
  /** 是否必填（用于通用校验提示） */
  required?: boolean;
  /** 是否对值做 trim（默认 true） */
  trim?: boolean;
}

/**
 * 图床 Uploader 接口
 *
 * 类型参数 TConfig：该 provider 的配置形状。注册到全局注册表时会被擦除为 unknown，
 * 由 provider 内部断言/校验。
 */
export interface ImageUploader<TConfig = unknown> {
  /** 唯一标识，如 'qiniu' / 'aliyun-oss' / 'tencent-cos' */
  readonly id: string;
  /** 显示名 */
  readonly name: string;
  /** 字段元数据，用于设置面板自动渲染 */
  readonly fields: ReadonlyArray<ProviderField>;

  /** 默认配置（用于初始化） */
  defaultConfig(): TConfig;
  /** 校验配置；返回错误信息或 null */
  validate(config: TConfig): string | null;
  /** 执行上传 */
  upload(
    config: TConfig,
    file: File | Blob,
    fileName: string,
    timeoutMs: number
  ): Promise<UploadResult>;

  /** 可选：清理 provider 内部缓存（如 token、签名缓存）。设置变更或卸载时调用 */
  clearCache?(): void;
}
