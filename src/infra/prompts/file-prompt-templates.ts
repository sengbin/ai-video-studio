// ------------------------------------------------------------------------
// 名称：file-prompt-templates.ts
// 说明：提示词模板的文件实现：从 resources/prompts 目录读取 Markdown 模板并缓存。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：模板名称只允许小写字母、数字和连字符，防止读取目录之外的文件；读取时统一换行为 LF。
// ------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PromptTemplates } from '../../domain/ports/prompt-templates';

const TEMPLATE_NAME = /^[a-z0-9-]+$/;

/** 从目录中读取模板文件的实现。 */
export class FilePromptTemplates implements PromptTemplates {
  private readonly cache = new Map<string, string>();

  /**
   * @param directory 模板目录的绝对路径，如扩展根目录下的 resources/prompts。
   */
  constructor(private readonly directory: string) {}

  get(name: string): string {
    if (!TEMPLATE_NAME.test(name)) {
      throw new Error(`提示词模板名称不合法：${name}`);
    }
    const cached = this.cache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const template = readFileSync(join(this.directory, `${name}.md`), 'utf8').replace(/\r\n/g, '\n');
    this.cache.set(name, template);
    return template;
  }
}
