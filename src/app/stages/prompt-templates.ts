// ------------------------------------------------------------------------
// 名称：prompt-templates.ts
// 说明：提示词模板工具：渲染变量、列出变量、把用户素材包裹为“数据段”防止被当作指令。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：模板来源接口见 domain/ports/prompt-templates.ts；变量写作 {{名称}}，渲染只做一次替换，素材中出现的 {{…}} 不会被再次解析。
// ------------------------------------------------------------------------

const VARIABLE = /\{\{(\w+)\}\}/g;
const MATERIAL_TAG = /<\/?素材[^>]*>/g;

/**
 * 列出模板中出现的变量名，按首次出现的顺序，去重。
 * @param template 模板全文。
 */
export function listTemplateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VARIABLE)].map((match) => match[1]))];
}

/**
 * 渲染模板：把 {{名称}} 替换为对应变量。
 * @param template 模板全文。
 * @param variables 变量表；多余的变量被忽略。
 * @throws Error 模板中的变量在变量表里不存在。
 */
export function renderTemplate(template: string, variables: Readonly<Record<string, string>>): string {
  return template.replace(VARIABLE, (_placeholder, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      throw new Error(`提示词模板缺少变量：${name}`);
    }
    return value;
  });
}

/**
 * 把素材包裹为数据段；素材内部的素材标记会被改成全角，避免提前结束数据段。
 * @param text 用户素材原文。
 */
export function wrapMaterial(text: string): string {
  return `<素材>\n${text.replace(MATERIAL_TAG, (tag) => tag.replace('<', '＜'))}\n</素材>`;
}
