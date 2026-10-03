// ------------------------------------------------------------------------
// 名称：sqlite-provider-repository.ts
// 说明：模型服务商、模型与模型能力数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：服务商设置在 providers.settings_json，能力在 model_capabilities.capability_json（snake_case 键）；密钥不入库。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { ModelKind } from '../../domain/models/model-capability';
import { ModelDescriptor, ModelRecord, NewProvider, ProviderPatch, ProviderRecord, ProviderSettings } from '../../domain/models/model-provider';
import { ModelFilter, ProviderRepository } from '../../domain/ports/provider-repository';
import { parseCapability, serializeCapability } from '../../domain/rules/model-capability-rules';
import { runInTransaction } from './transaction';

/** providers 表的一行。 */
interface ProviderRow {
  readonly id: number;
  readonly code: string;
  readonly display_name: string;
  readonly settings_json: string;
  readonly is_enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 模型与能力联查的一行。 */
interface ModelRow {
  readonly id: number;
  readonly provider_id: number;
  readonly code: string;
  readonly display_name: string;
  readonly kind: ModelKind;
  readonly is_enabled: number;
  readonly created_at: string;
  readonly capability_json: string;
}

const MODEL_SELECT = `SELECT m.id, m.provider_id, m.code, m.display_name, m.kind, m.is_enabled, m.created_at, c.capability_json
  FROM models m JOIN model_capabilities c ON c.model_id = m.id`;

function toProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    settings: JSON.parse(row.settings_json) as ProviderSettings,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toModel(row: ModelRow): ModelRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    code: row.code,
    displayName: row.display_name,
    kind: row.kind,
    isEnabled: row.is_enabled === 1,
    capability: parseCapability(row.capability_json),
    createdAt: row.created_at
  };
}

/** 基于 SQLite 的服务商与模型仓库。 */
export class SqliteProviderRepository implements ProviderRepository {
  constructor(private readonly database: DatabaseSync) {}

  listProviders(): ProviderRecord[] {
    const rows = this.database.prepare('SELECT * FROM providers ORDER BY id').all() as unknown as ProviderRow[];
    return rows.map(toProvider);
  }

  findProviderById(id: number): ProviderRecord | undefined {
    const row = this.database.prepare('SELECT * FROM providers WHERE id = ?').get(id) as unknown as ProviderRow | undefined;
    return row === undefined ? undefined : toProvider(row);
  }

  findProviderByCode(code: string): ProviderRecord | undefined {
    const row = this.database.prepare('SELECT * FROM providers WHERE code = ?').get(code) as unknown as ProviderRow | undefined;
    return row === undefined ? undefined : toProvider(row);
  }

  insertProvider(provider: NewProvider, timestamp: string): ProviderRecord {
    const result = this.database
      .prepare('INSERT INTO providers (code, display_name, settings_json, is_enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(provider.code, provider.displayName, JSON.stringify(provider.settings), timestamp, timestamp);
    return this.requireProvider(Number(result.lastInsertRowid));
  }

  updateProviderName(id: number, displayName: string, timestamp: string): void {
    this.database
      .prepare('UPDATE providers SET display_name = ?, updated_at = ? WHERE id = ? AND display_name <> ?')
      .run(displayName, timestamp, id, displayName);
  }

  updateProvider(id: number, patch: ProviderPatch, timestamp: string): ProviderRecord | undefined {
    const current = this.findProviderById(id);
    if (current === undefined) {
      return undefined;
    }
    const isEnabled = patch.isEnabled ?? current.isEnabled;
    const settings = patch.settings ?? current.settings;
    this.database
      .prepare('UPDATE providers SET is_enabled = ?, settings_json = ?, updated_at = ? WHERE id = ?')
      .run(isEnabled ? 1 : 0, JSON.stringify(settings), timestamp, id);
    return this.requireProvider(id);
  }

  listModels(filter: ModelFilter = {}): ModelRecord[] {
    const conditions: string[] = [];
    const parameters: Array<number | string> = [];
    if (filter.providerId !== undefined) {
      conditions.push('m.provider_id = ?');
      parameters.push(filter.providerId);
    }
    if (filter.kind !== undefined) {
      conditions.push('m.kind = ?');
      parameters.push(filter.kind);
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    const rows = this.database.prepare(`${MODEL_SELECT}${where} ORDER BY m.provider_id, m.kind, m.id`).all(...parameters) as unknown as ModelRow[];
    return rows.map(toModel);
  }

  findModelById(id: number): ModelRecord | undefined {
    const row = this.database.prepare(`${MODEL_SELECT} WHERE m.id = ?`).get(id) as unknown as ModelRow | undefined;
    return row === undefined ? undefined : toModel(row);
  }

  upsertModel(providerId: number, descriptor: ModelDescriptor, timestamp: string): ModelRecord {
    const capabilityJson = serializeCapability(descriptor.capability);
    const id = runInTransaction(this.database, () => {
      const existing = this.database
        .prepare('SELECT id FROM models WHERE provider_id = ? AND code = ?')
        .get(providerId, descriptor.code) as unknown as { id: number } | undefined;
      if (existing === undefined) {
        // 文本模型默认不启用：用户在服务商设置中主动启用后才出现在文本模型选择列表中。
        const result = this.database
          .prepare('INSERT INTO models (provider_id, code, display_name, kind, is_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(providerId, descriptor.code, descriptor.displayName, descriptor.kind, descriptor.kind === 'text' ? 0 : 1, timestamp);
        const modelId = Number(result.lastInsertRowid);
        this.database
          .prepare('INSERT INTO model_capabilities (model_id, capability_json, updated_at) VALUES (?, ?, ?)')
          .run(modelId, capabilityJson, timestamp);
        return modelId;
      }
      this.database.prepare('UPDATE models SET display_name = ?, kind = ? WHERE id = ?').run(descriptor.displayName, descriptor.kind, existing.id);
      this.database
        .prepare('UPDATE model_capabilities SET capability_json = ?, updated_at = ? WHERE model_id = ?')
        .run(capabilityJson, timestamp, existing.id);
      return existing.id;
    });
    return this.requireModel(id);
  }

  disableModelsExcept(providerId: number, keepCodes: readonly string[]): void {
    const placeholders = keepCodes.map(() => '?').join(', ');
    const keepClause = keepCodes.length === 0 ? '' : ` AND code NOT IN (${placeholders})`;
    this.database.prepare(`UPDATE models SET is_enabled = 0 WHERE provider_id = ?${keepClause}`).run(providerId, ...keepCodes);
  }

  setModelEnabled(id: number, isEnabled: boolean): boolean {
    const result = this.database.prepare('UPDATE models SET is_enabled = ? WHERE id = ?').run(isEnabled ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  private requireProvider(id: number): ProviderRecord {
    const provider = this.findProviderById(id);
    if (provider === undefined) {
      throw new Error(`服务商 ${id} 写入后读取不到。`);
    }
    return provider;
  }

  private requireModel(id: number): ModelRecord {
    const model = this.findModelById(id);
    if (model === undefined) {
      throw new Error(`模型 ${id} 写入后读取不到。`);
    }
    return model;
  }
}
