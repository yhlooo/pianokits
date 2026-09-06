import type { LibraryItem } from '../storage/library'
import { formatSize } from '../storage/library'
import { el } from './dom'
import { keysArtIcon, plusIcon, refreshIcon, sidebarIcon, xIcon } from './icons'
import type { View } from './store'

export interface LibraryViewCallbacks {
  onImport(files: File[]): void | Promise<void>
  onSelect(id: string): void | Promise<void>
  onRemove(id: string): void | Promise<void>
  onReimport(files: File[], id: string): void | Promise<void>
  onCollapse(): void
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY/M/D */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(timestamp)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 文件库侧栏：标题行（导入为图标按钮）+ 持久化列表（hover 动作）+ 空状态 + 拖放导入 */
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

    const importBtn = el('button', {
      class: 'icon-btn library__import',
      title: '导入 MIDI',
    })
    importBtn.append(plusIcon())
    importBtn.addEventListener('click', () => this.fileInput.click())

    // 侧栏左下角的收起按钮：点击后整栏隐藏，由播放坞最左的展开按钮恢复（共用同一侧栏图标）
    const collapseBtn = el('button', {
      class: 'icon-btn library__collapse',
      title: '收起侧栏',
    })
    collapseBtn.append(sidebarIcon())
    collapseBtn.addEventListener('click', () => this.cbs.onCollapse())

    this.el = el(
      'aside',
      { class: 'library' },
      el(
        'div',
        { class: 'library__head' },
        el('h2', { class: 'library__title' }, '文件库'),
        importBtn,
      ),
      this.listEl,
      el('div', { class: 'library__foot' }, collapseBtn),
      this.fileInput,
      this.reimportInput,
    )

    // 拖放导入：整个侧栏兼作拖放区
    let dragDepth = 0
    this.el.addEventListener('dragenter', (e) => {
      e.preventDefault()
      dragDepth++
      this.el.classList.add('is-drop')
    })
    this.el.addEventListener('dragover', (e) => e.preventDefault())
    this.el.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) this.el.classList.remove('is-drop')
    })
    this.el.addEventListener('drop', (e) => {
      e.preventDefault()
      dragDepth = 0
      this.el.classList.remove('is-drop')
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => /\.midi?$/i.test(f.name))
      if (files.length > 0) void cbs.onImport(files)
    })
  }

  setFiles(files: LibraryItem[]): void {
    this.listEl.replaceChildren()
    if (files.length === 0) {
      const emptyImport = el('button', { class: 'btn-outline' }, '导入 MIDI')
      emptyImport.addEventListener('click', () => this.fileInput.click())
      const art = el('div', { class: 'library__empty-art' })
      art.append(keysArtIcon())
      this.listEl.append(
        el(
          'li',
          { class: 'library__empty' },
          art,
          el('p', { class: 'library__empty-title' }, '还没有曲目'),
          el(
            'p',
            { class: 'library__empty-hint' },
            '导入 MIDI 文件开始播放，文件保存在浏览器本地（IndexedDB），刷新后仍在；也可以直接把 .mid 文件拖进侧栏',
          ),
          emptyImport,
        ),
      )
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
          `${formatSize(item.size)} · ${formatRelativeTime(item.importedAt)}`,
        ),
      )
      li.append(body)
      const re = el('button', { class: 'icon-btn library__item-re', title: '重新导入更新快照' })
      re.append(refreshIcon())
      re.addEventListener('click', (e) => {
        e.stopPropagation()
        this.pendingReimportId = item.id
        this.reimportInput.click()
      })
      const del = el('button', { class: 'icon-btn library__item-del', title: '删除' })
      del.append(xIcon())
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.cbs.onRemove(item.id)
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
