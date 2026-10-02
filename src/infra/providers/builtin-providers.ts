// ------------------------------------------------------------------------
// 名称：builtin-providers.ts
// 说明：内置模型适配器的登记：创建注册表并登记扩展自带的服务商适配器。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：新增服务商或模型类型时，只在这里增加一行登记，不改动服务层和界面。
// ------------------------------------------------------------------------

import { ProviderRegistry } from '../../domain/ports/provider-registry';
import { QianwenVideoProvider } from './qianwen/qianwen-video-provider';

/** 创建登记了全部内置适配器的注册表。 */
export function createBuiltinProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry().register(new QianwenVideoProvider());
}
