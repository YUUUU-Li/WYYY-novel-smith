/* ============================================================
   File System Access API 的类型补充

   TypeScript 的 lib.dom.d.ts 目前只收录了这组 API 的一部分：
   getDirectoryHandle / getFileHandle / removeEntry / resolve 有官方类型，
   但 values()（异步迭代目录）、showDirectoryPicker（选择文件夹）、
   queryPermission（查询已授权状态）三个还没有。

   这三个恰好都是我们必需的，所以在这里补上，而不是用 any 糊过去。
   ============================================================ */

declare global {
  interface FileSystemDirectoryHandle {
    /** 异步迭代目录条目。官方尚未收录，浏览器（Chromium 系）已实现。 */
    values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>
    /** 已授权状态的查询。与 requestPermission 相对。 */
    queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  }

  interface FileSystemWritableFileStream {
    write(data: string | BufferSource | Blob): Promise<void>
  }

  interface Window {
    /** 弹出系统文件夹选择器。仅在 Chromium 系浏览器且用户手势中可用。 */
    showDirectoryPicker?: (options?: {
      id?: string
      mode?: 'read' | 'readwrite'
      startIn?: string
    }) => Promise<FileSystemDirectoryHandle>
  }
}

export {}
