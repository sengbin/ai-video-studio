// ------------------------------------------------------------------------
// 名称：asset-file-store.ts
// 说明：资产图片、音频文件存储的端口接口：把文件内容保存为磁盘文件，数据库只记录相对路径。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：同步调用，与资产仓库的同步接口一致；路径由内容哈希决定，相同内容只保存一份，所以删除前必须确认没有其他记录引用同一路径；实现位于 infra/storage/local-asset-file-store.ts。
// ------------------------------------------------------------------------

/** 资产文件存储：仓库通过它读写文件内容，不直接依赖具体的存储位置。 */
export interface AssetFileStore {
  /**
   * 保存文件内容；相同内容已存在时不重复写入。
   * @param content 文件内容。
   * @param mime 文件类型，用于决定扩展名。
   * @returns 相对存储根目录、使用 `/` 分隔的路径。
   * @throws 写入失败时抛出错误，不会留下写了一半的文件。
   */
  write(content: Buffer, mime: string): string;

  /**
   * 读取文件内容。
   * @param filePath 保存时返回的相对路径。
   * @throws 路径不合法或文件不存在时抛出错误。
   */
  read(filePath: string): Buffer;

  /**
   * 删除文件；文件不存在时什么也不做。
   * @param filePath 保存时返回的相对路径。
   * @throws 路径不合法时抛出错误。
   */
  remove(filePath: string): void;
}
