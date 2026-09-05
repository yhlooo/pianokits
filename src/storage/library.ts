import { deleteFileRecord, getAllFileRecords, getFileRecord, putFileRecord } from './db'

export interface LibraryItem {
  id: string
  name: string
  size: number
  importedAt: number
}

/**
 * 文件库（方案 B：仅存内容副本到 IndexedDB，设计文档 §5.3、§6.1）。
 * 快照语义：原文件在磁盘上的修改不影响列表内容，用户可"重新导入"更新。
 */
export class FileLibrary {
  async importFiles(files: File[]): Promise<LibraryItem[]> {
    const imported: LibraryItem[] = []
    for (const file of files) {
      const bytes = await file.arrayBuffer()
      const record = {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        importedAt: Date.now(),
        bytes,
      }
      await putFileRecord(record)
      imported.push({
        id: record.id,
        name: record.name,
        size: record.size,
        importedAt: record.importedAt,
      })
    }
    // 降低驱逐风险（成本极低；不成功也无妨）
    if (typeof navigator.storage !== 'undefined' && 'persist' in navigator.storage) {
      navigator.storage.persist().catch(() => {})
    }
    return imported
  }

  async list(): Promise<LibraryItem[]> {
    const records = await getAllFileRecords()
    return records
      .map((r) => ({ id: r.id, name: r.name, size: r.size, importedAt: r.importedAt }))
      .sort((a, b) => b.importedAt - a.importedAt)
  }

  async read(id: string): Promise<ArrayBuffer> {
    const record = await getFileRecord(id)
    if (record === null) throw new Error('文件不存在，可能已被删除')
    return record.bytes
  }

  /** 重新导入：保留条目 id，更新快照内容 */
  async replaceFile(id: string, file: File): Promise<void> {
    const bytes = await file.arrayBuffer()
    await putFileRecord({
      id,
      name: file.name,
      size: file.size,
      importedAt: Date.now(),
      bytes,
    })
  }

  async remove(id: string): Promise<void> {
    await deleteFileRecord(id)
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
