/** IndexedDB 封装（唯一持久化路径，设计文档 §5.3） */

const DB_NAME = 'pianokits'
const DB_VERSION = 1
export const STORE_FILES = 'files'
export const STORE_SETTINGS = 'settings'

export interface FileRecord {
  id: string
  name: string
  size: number
  importedAt: number
  bytes: ArrayBuffer
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
  return dbPromise
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export async function putFileRecord(record: FileRecord): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE_FILES, 'readwrite')
  tx.objectStore(STORE_FILES).put(record)
  await txDone(tx)
}

export async function getAllFileRecords(): Promise<FileRecord[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_FILES, 'readonly').objectStore(STORE_FILES).getAll()
    req.onsuccess = () => resolve(req.result as FileRecord[])
    req.onerror = () => reject(req.error ?? new Error('IndexedDB getAll failed'))
  })
}

export async function getFileRecord(id: string): Promise<FileRecord | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_FILES, 'readonly').objectStore(STORE_FILES).get(id)
    req.onsuccess = () => resolve((req.result as FileRecord | undefined) ?? null)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'))
  })
}

export async function deleteFileRecord(id: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE_FILES, 'readwrite')
  tx.objectStore(STORE_FILES).delete(id)
  await txDone(tx)
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_SETTINGS, 'readonly').objectStore(STORE_SETTINGS).get(key)
    req.onsuccess = () => {
      const row = req.result as { value: T } | undefined
      resolve(row === undefined ? null : row.value)
    }
    req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'))
  })
}

export async function putSetting<T>(key: string, value: T): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE_SETTINGS, 'readwrite')
  tx.objectStore(STORE_SETTINGS).put({ key, value })
  await txDone(tx)
}
