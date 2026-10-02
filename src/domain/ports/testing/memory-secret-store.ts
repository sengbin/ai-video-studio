// ------------------------------------------------------------------------
// 名称：memory-secret-store.ts
// 说明：测试用的内存密钥存储。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：仅供测试使用，随 out/**/testing 一起被打包排除。
// ------------------------------------------------------------------------

import { SecretStore } from '../secret-store';

/** 保存在内存中的密钥存储。 */
export class MemorySecretStore implements SecretStore {
  /** 当前保存的全部密钥，便于测试检查。 */
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
