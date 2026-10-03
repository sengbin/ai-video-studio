// ------------------------------------------------------------------------
// 名称：copilot-text-generation.test.ts
// 说明：Copilot 文本生成端口的自动化测试：模型选择规则——指定家族只用该家族且没有匹配时报不可用，自动（空家族）才选任意可用的模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：用假的 vscode 模块替换 VS Code 的语言模型接口，不依赖 VS Code；假模块只在加载被测文件的瞬间生效。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';
import { TextGenerationError } from '../../domain/errors';
import type { CopilotTextGeneration as CopilotTextGenerationClass } from './copilot-text-generation';

/** 假的语言模型：只有选择规则用到的属性。 */
interface FakeModel {
  readonly vendor: string;
  readonly family: string;
  readonly maxInputTokens: number;
}

/** 当前可用的假模型；每个测试自行设置。 */
let availableModels: FakeModel[] = [];
/** 记录 selectChatModels 收到的筛选条件。 */
const selectors: Array<{ vendor?: string; family?: string }> = [];

const fakeVscode = {
  lm: {
    selectChatModels: async (selector: { vendor?: string; family?: string }): Promise<FakeModel[]> => {
      selectors.push(selector);
      return availableModels.filter((model) => (selector.vendor === undefined || model.vendor === selector.vendor) && (selector.family === undefined || model.family === selector.family));
    }
  }
};

/** 加载被测文件：加载期间把对 vscode 的引用指向假模块。 */
function loadCopilotTextGeneration(): typeof CopilotTextGenerationClass {
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? fakeVscode : original.call(this, request, ...rest);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('./copilot-text-generation') as { CopilotTextGeneration: typeof CopilotTextGenerationClass }).CopilotTextGeneration;
  } finally {
    loader._load = original;
  }
}

const CopilotTextGeneration = loadCopilotTextGeneration();

const CLAUDE: FakeModel = { vendor: 'copilot', family: 'claude-sonnet', maxInputTokens: 1000 };
const GPT: FakeModel = { vendor: 'copilot', family: 'gpt-4o', maxInputTokens: 2000 };

async function rejectedWith(action: Promise<unknown>): Promise<TextGenerationError> {
  try {
    await action;
  } catch (error) {
    assert.ok(error instanceof TextGenerationError, '应抛出 TextGenerationError');
    return error;
  }
  assert.fail('应抛出错误');
}

test('指定家族：选中该家族的模型，只按该家族筛选', async () => {
  availableModels = [CLAUDE, GPT];
  selectors.length = 0;
  assert.deepEqual(await new CopilotTextGeneration('gpt-4o').resolveModel(), { id: 'copilot/gpt-4o', maxInputTokens: 2000 });
  assert.deepEqual(selectors, [{ vendor: 'copilot', family: 'gpt-4o' }]);
});

test('指定家族但没有匹配的模型：报不可用并提示到“模型设置”更换，不换成别的模型', async () => {
  availableModels = [CLAUDE];
  selectors.length = 0;
  const error = await rejectedWith(new CopilotTextGeneration('gpt-4o').resolveModel());
  assert.equal(error.category, 'unavailable');
  assert.ok(error.message.includes('gpt-4o') && error.message.includes('模型设置'));
  assert.deepEqual(selectors, [{ vendor: 'copilot', family: 'gpt-4o' }], '没有第二次不带家族的查询');

  // 没有 resolveModel 时，countTokens 同样不会悄悄换成别的模型。
  const lazy = await rejectedWith(new CopilotTextGeneration('gpt-4o').countTokens('文本'));
  assert.equal(lazy.category, 'unavailable');
});

test('自动（家族为空）：选任意可用的 Copilot 模型；一个都没有时报不可用', async () => {
  availableModels = [CLAUDE, GPT];
  selectors.length = 0;
  assert.deepEqual(await new CopilotTextGeneration().resolveModel(), { id: 'copilot/claude-sonnet', maxInputTokens: 1000 });
  assert.deepEqual(selectors, [{ vendor: 'copilot' }]);

  availableModels = [];
  const error = await rejectedWith(new CopilotTextGeneration('').resolveModel());
  assert.equal(error.category, 'unavailable');
  assert.ok(error.message.includes('GitHub Copilot'));
});
