// ------------------------------------------------------------------------
// 名称：json-output.ts
// 说明：从模型输出中提取 JSON：兼容代码块包裹和前后夹带说明文字的情况。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：解析失败抛出 GeneratedOutputError，其提示可直接反馈给模型重试。
// ------------------------------------------------------------------------

import { GeneratedOutputError } from '../errors';

const NOT_JSON_MESSAGE = '输出不是合法的 JSON，请只输出一个 JSON，不要添加说明文字。';

/** 尝试解析文本，失败返回 undefined（JSON 值本身不会是 undefined）。 */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 解析模型输出中的 JSON 值。依次尝试：整段文本、代码块内容、第一个 { 或 [ 到与之配对的最后一个 } 或 ]。
 * @param text 模型的原始输出。
 * @throws GeneratedOutputError 找不到合法的 JSON。
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const whole = tryParse(trimmed);
  if (whole !== undefined) {
    return whole;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced !== null) {
    const inFence = tryParse(fenced[1].trim());
    if (inFence !== undefined) {
      return inFence;
    }
  }

  const start = trimmed.search(/[{[]/);
  if (start >= 0) {
    const closer = trimmed[start] === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(closer);
    if (end > start) {
      const embedded = tryParse(trimmed.slice(start, end + 1));
      if (embedded !== undefined) {
        return embedded;
      }
    }
  }
  throw new GeneratedOutputError([NOT_JSON_MESSAGE]);
}
