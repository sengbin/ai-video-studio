// ------------------------------------------------------------------------
// 名称：http-media-downloader.ts
// 说明：媒体下载的 HTTP 实现：只允许 https 地址，按大小上限读取响应内容；fetch 可注入以便测试。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：先看 Content-Length 提前拒绝过大的文件，读取过程中再按实际字节数检查一次。
// ------------------------------------------------------------------------

import { MediaDownloader } from '../../domain/ports/media-downloader';

/** 基于 fetch 的媒体下载器。 */
export class HttpMediaDownloader implements MediaDownloader {
  /**
   * @param fetchFunction 发起网络请求的函数，测试时可注入假实现。
   */
  constructor(private readonly fetchFunction: typeof fetch = fetch) {}

  async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    if (!url.startsWith('https://')) {
      throw new Error('下载地址必须是 https 地址。');
    }
    const response = await this.fetchFunction(url, { signal });
    if (!response.ok) {
      throw new Error(`下载失败（HTTP ${response.status}）。`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error('文件超过大小上限。');
    }
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > maxBytes) {
      throw new Error('文件超过大小上限。');
    }
    return content;
  }
}
