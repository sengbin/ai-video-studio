// ------------------------------------------------------------------------
// 名称：vscode-secret-store.ts
// 说明：密钥存储端口的 VS Code 实现：委托给扩展上下文的 SecretStorage。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：SecretStorage 由 VS Code 加密保存在系统凭据库中，不随设置同步到其他设备的明文文件。
// ------------------------------------------------------------------------

import type * as vscode from 'vscode';
import { SecretStore } from '../../domain/ports/secret-store';

/** 基于 VS Code SecretStorage 的密钥存储。 */
export class VsCodeSecretStore implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}
