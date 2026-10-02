// ------------------------------------------------------------------------
// 名称：media-downloader.ts
// 说明：媒体下载的端口接口：把服务商返回的临时地址下载为字节，用于图像、音频生成结果。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：领域层与应用层不依赖具体的网络实现；测试中用假实现替代。
// ------------------------------------------------------------------------

/** 媒体下载接口。 */
export interface MediaDownloader {
  /**
   * 下载一个文件到内存。
   * @param url 服务商返回的临时地址，必须是 https 地址。
   * @param maxBytes 允许的最大字节数，超过时失败。
   * @param signal 取消信号。
   * @throws Error 地址不合法、请求失败或文件过大。
   */
  download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
}
