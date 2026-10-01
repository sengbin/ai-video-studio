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
    if (text.includes('# 任务：撰写剧本包')) {
      return JSON.stringify({
        title: '雨夜来客',
        overview: '题材：悬疑。灯塔守夜人在雨夜收到神秘信号，顺着信号找到多年前失踪的人。',
        fullText: '第一集 信号\n场景一 灯塔内 夜\n守夜人点亮灯塔，翻开值班日志。\n老陈：今晚会下雨。\n\n第二集 海面\n场景二 海边 夜\n老陈划船出海，寻找信号来源。'
      });
    }
    if (text.includes('# 任务：从剧本中抽取集和实体')) {
      const single = text.includes('这是单个短视频，只有 1 集。');
      const maxEpisodes = Number(/最多 (\d+) 集/.exec(text)?.[1] ?? 2);
      const episodes = single
        ? [{ synopsis: '守夜人在雨夜顺着信号出海。', targetDurationSeconds: 45 }]
        : [
            { title: '信号', synopsis: '守夜人收到神秘信号。', screenplayText: '场景一 灯塔内 夜\n守夜人点亮灯塔，翻开值班日志。', targetDurationSeconds: 45 },
            { title: '海面', synopsis: '老陈出海寻找信号。', screenplayText: '场景二 海边 夜\n老陈划船出海，寻找信号来源。', targetDurationSeconds: 45 }
          ].slice(0, maxEpisodes);
      return JSON.stringify({
        episodes,
        entities: [
          { kind: 'character', name: '老陈', aliases: ['守夜人'], description: '守了三十年灯塔的老人。', attributes: { identity: '灯塔守夜人', voice: '低沉沙哑' } },
          { kind: 'scene', name: '灯塔', description: '海边的旧灯塔。', attributes: { interior_exterior: '内景', time_light: '夜晚，灯光每转一圈照亮一次浪尖' } },
          { kind: 'prop', name: '值班日志', description: '记录每晚情况的旧本子。', attributes: { appearance: '深色封皮，边角磨损' } }
        ]
      });
    }
    return JSON.stringify({ refused: '示例应答无法处理该任务。' });
  };
}

module.exports = { createResponder };
