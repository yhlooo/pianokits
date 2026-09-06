import type { LibraryItem } from '../storage/library'
import { formatSize } from '../storage/library'
import { el } from './dom'
import { keysArtIcon, plusIcon, sidebarIcon, xIcon } from './icons'
import type { View } from './store'

export interface LibraryViewCallbacks {
  onImport(files: File[]): void | Promise<void>
  onSelect(id: string): void | Promise<void>
  onRemove(id: string): void | Promise<void>
  onCollapse(): void
}

/** 列表展示用文件名：去掉 .mid / .midi 后缀（大小写不敏感） */
function displayName(name: string): string {
  return name.replace(/\.(mid|midi)$/i, '')
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

/** 音乐库侧栏：标题行（导入为图标按钮）+ 持久化列表（hover 动作）+ 空状态 + 拖放导入 */
export class LibraryView implements View {
  readonly el: HTMLElement
  private readonly fileInput: HTMLInputElement
  private readonly listEl: HTMLUListElement
  private readonly cbs: LibraryViewCallbacks
  private selectedId: string | null = null

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
        el('h2', { class: 'library__title' }, '音乐库'),
        importBtn,
      ),
      this.listEl,
      el('div', { class: 'library__foot' }, collapseBtn),
      this.fileInput,
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
          el('p', { class: 'library__empty-hint' }, '导入或拖入 MIDI 文件(.mid) 开始播放'),
          emptyImport,
        ),
      )
      return
    }
    for (const item of files) {
      const name = displayName(item.name)
      const li = el('li', {
        class: 'library__item' + (item.id === this.selectedId ? ' is-selected' : ''),
        dataset: { id: item.id },
        title: name,
      })
      const body = el('div', { class: 'library__item-body' })
      body.append(
        el('div', { class: 'library__item-name' }, name),
        el(
          'div',
          { class: 'library__item-meta' },
          `${formatSize(item.size)} · ${formatRelativeTime(item.importedAt)}`,
        ),
      )
      li.append(body)
      const del = el('button', { class: 'icon-btn library__item-del', title: '删除' })
      del.append(xIcon())
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.cbs.onRemove(item.id)
      })
      li.append(del)
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
