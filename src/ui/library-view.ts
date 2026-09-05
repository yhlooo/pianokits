import type { LibraryItem } from '../storage/library'
import { formatSize } from '../storage/library'
import { el } from './dom'
import type { View } from './store'

export interface LibraryViewCallbacks {
  onImport(files: File[]): void | Promise<void>
  onSelect(id: string): void | Promise<void>
  onRemove(id: string): void | Promise<void>
  onReimport(files: File[], id: string): void | Promise<void>
}

/** 文件库侧栏：导入按钮 + 持久化列表（名称/大小/时间，选中态，删除/重新导入） */
export class LibraryView implements View {
  readonly el: HTMLElement
  private readonly fileInput: HTMLInputElement
  private readonly reimportInput: HTMLInputElement
  private readonly listEl: HTMLUListElement
  private readonly cbs: LibraryViewCallbacks
  private selectedId: string | null = null
  private pendingReimportId: string | null = null

  constructor(cbs: LibraryViewCallbacks) {
    this.cbs = cbs

    this.fileInput = el('input', {
      type: 'file',
      accept: '.mid,.midi,audio/midi,audio/x-midi',
      multiple: true,
      class: 'hidden-input',
    })
    this.fileInput.addEventListener('change', () => {
      const files = Array.from(this.fileInput.files ?? [])
      this.fileInput.value = ''
      if (files.length > 0) void cbs.onImport(files)
    })

    this.reimportInput = el('input', {
      type: 'file',
      accept: '.mid,.midi,audio/midi,audio/x-midi',
      multiple: false,
      class: 'hidden-input',
    })
    this.reimportInput.addEventListener('change', () => {
      const files = Array.from(this.reimportInput.files ?? [])
      this.reimportInput.value = ''
      const id = this.pendingReimportId
      this.pendingReimportId = null
      if (files.length > 0 && id !== null) void cbs.onReimport(files, id)
    })

    this.listEl = el('ul', { class: 'library__list' })

    this.el = el(
      'aside',
      { class: 'library' },
      el('h2', { class: 'library__title' }, '文件库'),
      el(
        'button',
        {
          class: 'library__import',
          onclick: () => this.fileInput.click(),
        },
        '导入 MIDI',
      ),
      el('p', { class: 'library__hint' }, '文件保存在浏览器本地（IndexedDB），刷新后仍在'),
      this.listEl,
      this.fileInput,
      this.reimportInput,
    )
  }

  setFiles(files: LibraryItem[]): void {
    this.listEl.replaceChildren()
    if (files.length === 0) {
      this.listEl.append(el('li', { class: 'library__empty' }, '还没有导入文件'))
      return
    }
    for (const item of files) {
      const li = el('li', {
        class: 'library__item' + (item.id === this.selectedId ? ' is-selected' : ''),
        dataset: { id: item.id },
        title: item.name,
      })
      const body = el('div', { class: 'library__item-body' })
      body.append(
        el('div', { class: 'library__item-name' }, item.name),
        el(
          'div',
          { class: 'library__item-meta' },
          `${formatSize(item.size)} · ${new Date(item.importedAt).toLocaleString()}`,
        ),
      )
      li.append(body)
      const del = el('button', { class: 'library__item-del', title: '删除' }, '×')
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.cbs.onRemove(item.id)
      })
      const re = el('button', { class: 'library__item-re', title: '重新导入更新快照' }, '↻')
      re.addEventListener('click', (e) => {
        e.stopPropagation()
        this.pendingReimportId = item.id
        this.reimportInput.click()
      })
      li.append(re, del)
      li.addEventListener('click', () => {
        void this.cbs.onSelect(item.id)
      })
      this.listEl.append(li)
    }
  }

  setSelected(id: string | null): void {
    this.selectedId = id
  }
}
