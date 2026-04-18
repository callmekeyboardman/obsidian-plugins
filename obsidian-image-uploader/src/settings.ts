import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import QiniuImageUploaderPlugin from '../main';
import {
  ImageUploader,
  ProviderField,
  getProvider,
  getProviderOptions,
} from './providers';
import { getErrorMessage } from './utils';

export class QiniuUploaderSettingTab extends PluginSettingTab {
  plugin: QiniuImageUploaderPlugin;

  constructor(app: App, plugin: QiniuImageUploaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * 保存设置；当指定 provider 有 clearCache 时一并清除其缓存
   */
  private async saveAndInvalidate(providerId?: string): Promise<void> {
    if (providerId) {
      const p = getProvider(providerId);
      p?.clearCache?.();
    }
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('图片上传').setHeading();

    // 启用/禁用开关
    new Setting(containerEl)
      .setName('启用上传')
      .setDesc('开启或关闭自动图片上传功能')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enabled)
        .onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        }));

    // 图床选择
    new Setting(containerEl)
      .setName('图床')
      .setDesc('选择当前使用的图床服务')
      .addDropdown(dropdown => {
        const options = getProviderOptions();
        Object.entries(options).forEach(([id, name]) => dropdown.addOption(id, name));
        dropdown
          .setValue(this.plugin.settings.activeProvider)
          .onChange(async (value) => {
            this.plugin.settings.activeProvider = value;
            // 切换 provider 后需要重渲染配置区域
            await this.plugin.saveSettings();
            this.display();
          });
      });

    // 上传超时（全局）
    new Setting(containerEl)
      .setName('上传超时（秒）')
      .setDesc('单次上传的最长等待时间，默认 30 秒')
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        const currentSeconds = Math.round(this.plugin.settings.uploadTimeoutMs / 1000);
        text
          .setPlaceholder('30')
          .setValue(String(currentSeconds))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === '') return; // 空值不立刻保存，blur 时再校验
            const seconds = Number(trimmed);
            if (Number.isFinite(seconds) && seconds > 0) {
              this.plugin.settings.uploadTimeoutMs = Math.round(seconds * 1000);
              await this.plugin.saveSettings();
            }
          });
        text.inputEl.addEventListener('blur', () => {
          const seconds = Number(text.inputEl.value);
          if (!Number.isFinite(seconds) || seconds <= 0) {
            new Notice('请输入大于 0 的正整数秒数');
            text.inputEl.value = String(Math.round(this.plugin.settings.uploadTimeoutMs / 1000));
          }
        });
      });

    // 本地图片上传后的原文件处理策略（右键菜单触发时生效）
    new Setting(containerEl)
      .setName('上传本地图片后')
      .setDesc('右键上传本地图片成功后，对原文件的处理方式')
      .addDropdown(dropdown => {
        dropdown
          .addOption('keep', '保留本地文件')
          .addOption('trash', '移到回收站')
          .addOption('delete', '永久删除')
          .setValue(this.plugin.settings.localFileAction)
          .onChange(async (value) => {
            if (value === 'keep' || value === 'trash' || value === 'delete') {
              this.plugin.settings.localFileAction = value;
              await this.plugin.saveSettings();
            }
          });
      });

    // 当前 provider 的字段配置
    const provider = getProvider(this.plugin.settings.activeProvider);
    if (!provider) {
      containerEl.createEl('p', {
        text: `未找到图床 provider: ${this.plugin.settings.activeProvider}`,
      });
      return;
    }

    new Setting(containerEl).setName(`${provider.name} 配置`).setHeading();
    this.renderProviderFields(provider);

    // 测试上传
    new Setting(containerEl)
      .setName('测试上传')
      .setDesc('使用 1x1 透明 PNG 测试当前图床配置是否正确')
      .addButton(button => button
        .setButtonText('测试上传')
        .onClick(async () => {
          await this.testUpload();
        }));
  }

  /**
   * 根据 provider.fields 元数据渲染配置项
   */
  private renderProviderFields(provider: ImageUploader): void {
    const { containerEl } = this;
    const config = this.plugin.settings.providers[provider.id] as Record<string, unknown>;

    for (const field of provider.fields) {
      this.renderField(containerEl, provider.id, config, field);
    }
  }

  private renderField(
    containerEl: HTMLElement,
    providerId: string,
    config: Record<string, unknown>,
    field: ProviderField
  ): void {
    const setting = new Setting(containerEl).setName(field.name);
    if (field.desc) setting.setDesc(field.desc);

    const trim = field.trim !== false;
    const currentValue = config[field.key];

    switch (field.type) {
      case 'text':
      case 'password':
      case 'number':
        setting.addText(text => {
          if (field.type === 'password') text.inputEl.type = 'password';
          if (field.type === 'number') {
            text.inputEl.type = 'number';
            text.inputEl.min = '0';
          }
          if (field.placeholder) text.setPlaceholder(field.placeholder);
          text
            .setValue(currentValue === undefined || currentValue === null ? '' : String(currentValue))
            .onChange(async (value) => {
              const next = trim ? value.trim() : value;
              if (field.type === 'number') {
                // 空字符串 → 视为未填，回退到默认值
                if (next === '') {
                  delete config[field.key];
                } else {
                  const num = Number(next);
                  if (!Number.isFinite(num)) return; // 非法输入：不写入
                  config[field.key] = num;
                }
              } else {
                config[field.key] = next;
              }
              await this.saveAndInvalidate(providerId);
            });
          if (field.type === 'number') {
            text.inputEl.addEventListener('blur', () => {
              const raw = text.inputEl.value.trim();
              if (raw === '') return; // 允许清空
              const num = Number(raw);
              if (!Number.isFinite(num)) {
                new Notice(`${field.name}: 请输入有效数字`);
                const cur = config[field.key];
                text.inputEl.value = cur === undefined || cur === null ? '' : String(cur);
              }
            });
          }
        });
        break;

      case 'dropdown':
        setting.addDropdown(dropdown => {
          if (field.options) {
            for (const [v, label] of Object.entries(field.options)) {
              dropdown.addOption(v, label);
            }
          }
          dropdown
            .setValue(currentValue === undefined || currentValue === null ? '' : String(currentValue))
            .onChange(async (value) => {
              config[field.key] = value;
              await this.saveAndInvalidate(providerId);
            });
        });
        break;
    }
  }

  async testUpload(): Promise<void> {
    const { activeProvider, providers, uploadTimeoutMs } = this.plugin.settings;
    const provider = getProvider(activeProvider);
    if (!provider) {
      new Notice(`未找到图床 provider: ${activeProvider}`);
      return;
    }
    const config = providers[activeProvider];
    const validateError = provider.validate(config);
    if (validateError) {
      new Notice(validateError);
      return;
    }

    const notice = new Notice(`正在测试上传到 ${provider.name}...`, 0);

    try {
      // 1x1 透明 PNG
      const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const byteCharacters = atob(testImageBase64);
      const byteNumbers = new Uint8Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const testBlob = new Blob([byteNumbers], { type: 'image/png' });

      const result = await provider.upload(config, testBlob, 'test.png', uploadTimeoutMs);
      new Notice(`上传成功！URL: ${result.url}`, 8000);
    } catch (error) {
      new Notice(`上传失败: ${getErrorMessage(error)}`, 8000);
      console.error('[ImageUploader] 测试上传失败:', error);
    } finally {
      notice.hide();
    }
  }
}
