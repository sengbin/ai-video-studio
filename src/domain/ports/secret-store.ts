// ------------------------------------------------------------------------
// 名称：secret-store.ts
// 说明：密钥存储端口：读取、保存和删除服务商访问密钥，由 VS Code SecretStorage 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：密钥不入库、不写入请求快照，也不发给界面。
// ------------------------------------------------------------------------

/** 密钥存储。 */
export interface SecretStore {
  /** 读取密钥；不存在返回 undefined。 */
  get(key: string): Promise<string | undefined>;

  /** 保存密钥，已有则覆盖。 */
  set(key: string, value: string): Promise<void>;

  /** 删除密钥；不存在时不报错。 */
  delete(key: string): Promise<void>;
}
