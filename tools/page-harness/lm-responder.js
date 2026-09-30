// ------------------------------------------------------------------------
// 名称：lm-responder.js
// 说明：页面测试工具用的假 Copilot 应答：按提示词中的任务标题返回符合约定的 JSON，让整条生成流程可以在没有 Copilot 的环境下跑通。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：仅供开发时手工验证页面使用；内容是可读的示例文字，不代表真实模型的输出质量。
// ------------------------------------------------------------------------

'use strict';

const SENTENCES = [
  '海风吹过灯塔的窗，守夜人放下手中的旧茶杯，望向漆黑的海面。',
  '远处传来一声很轻的汽笛，像是有人在很远的地方呼唤他的名字。',
  '他翻开值班日志，发现最新一页上多出了一行不属于自己的字迹。',
  '雨点敲在玻璃上，灯光每转一圈，就把浪尖照亮一次，又迅速交还给黑暗。',
  '他决定顺着信号的方向走下去，哪怕那条路早已被潮水淹没多年。'
];

/** 生成指定最少字数的示例正文。 */
function makeContent(minWords, seq) {
  let text = '';
  let index = seq;
  while (text.replace(/[^\u4e00-\u9fff]/g, '').length < minWords + 20) {
    text += SENTENCES[index % SENTENCES.length];
    index += 1;
  }
  return text;
}

/** 从提示词里读取“每章正文字数范围”的下限，读不到时用 120。 */
function readMinWords(text) {
  const match = /字数范围：(\d+) 到 (\d+) 字/.exec(text);
  return match ? Number(match[1]) : 120;
}

/** 创建应答函数：输入完整提示词，返回模型输出文本。 */
function createResponder() {
  return function respond(text) {
    if (text.includes('# 任务：提取原文要点')) {
      const index = /第 (\d+) 段/.exec(text)?.[1] ?? '';
      return JSON.stringify({ summary: `第 ${index} 段要点：人物出场、事件推进、关键设定。` });
    }
    if (text.includes('# 任务：分析灵感图片')) {
      return JSON.stringify({ summary: '画面：夜色中的灯塔与海面，冷色调，氛围孤寂。' });
    }
    if (text.includes('# 任务：规划章节大纲')) {
      const maxChapters = Number(/章节数上限：(\d+) 章/.exec(text)?.[1] ?? 3);
      const count = Math.min(3, maxChapters);
      const chapters = Array.from({ length: count }, (_, index) => ({
        title: ['开端', '转折', '结局'][index],
        summary: `第 ${index + 1} 章的梗概。`,
        sources: [index + 1]
      }));
      return JSON.stringify({ chapters });
    }
    const chapter = /# 任务：撰写第 (\d+) 章/.exec(text);
    if (chapter) {
      const seq = Number(chapter[1]);
      return JSON.stringify({ title: `第${seq}章 示例`, content: makeContent(readMinWords(text), seq) });
    }
    return JSON.stringify({ refused: '示例应答无法处理该任务。' });
  };
}

module.exports = { createResponder };
