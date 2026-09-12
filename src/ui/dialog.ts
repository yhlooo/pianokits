/** 模态弹窗原语：基于原生 <dialog> + showModal()，供二次确认与文件名输入复用 */

import { el } from './dom'

export interface ConfirmDialogOptions {
  title: string
  /** 正文文案 */
  message: string
  /** 确认按钮文案，默认 '确定' */
  confirmText?: string
  /** 危险动作（确认按钮红色），默认 false */
  danger?: boolean
}

export interface PromptDialogOptions {
  title: string
  /** 输入说明，可省略 */
  label?: string
  defaultValue: string
  /** 确认按钮文案，默认 '确定' */
  confirmText?: string
  /** 校验输入：返回错误文案表示不通过，返回 null 表示通过 */
  validate?: (value: string) => string | null
}

/** showModal 之后执行的收尾动作（聚焦主按钮、全选输入框文本等） */
type AfterShow = () => void

/** 自增计数：aria-labelledby / label[for] 需要全文档唯一的 id */
let idSeq = 0

/** 已打开弹窗的“取消”收尾回调：closeDialogs 借它兜底结算所有未决 Promise */
const pendingCancels = new Set<() => void>()

/** 交给 build 装配的弹窗部件 */
interface ModalParts<T> {
  /** 弹窗元素本身：需要 aria-describedby 等额外属性时用它 */
  dialog: HTMLDialogElement
  /** 面板容器：标题已就位，正文追加到这里 */
  panel: HTMLDivElement
  /** 动作行：按钮追加到这里（挂载时自动排到面板末尾） */
  actions: HTMLDivElement
  /** 结算弹窗（重复调用无效）；写成属性类型，便于解构后直接调用 */
  settle: (result: T) => void
}

interface ModalSpec<T> {
  title: string
  /** 取消（Esc / 点击遮罩 / closeDialogs）时的结算结果 */
  cancelResult: T
  /** 同步装配内容；返回 showModal 之后要执行的动作 */
  build(parts: ModalParts<T>): AfterShow
}

function nextId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

/**
 * 创建并打开模态弹窗，统一接管 Esc、点击遮罩、关闭清理与唯一结算。
 *
 * 关闭方式五花八门但结局只有两种：Esc 由原生实现自行 close（close 事件），
 * 点击遮罩不会自动关闭（规范未定义 light dismiss，需要自己实现），二者都收敛到“取消”。
 */
function createModal<T>(spec: ModalSpec<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const titleId = nextId('dialog-title')
    const dialog = el('dialog', { class: 'dialog', 'aria-labelledby': titleId })
    const panel = el('div', { class: 'dialog__panel' })
    const actions = el('div', { class: 'dialog__actions' })
    panel.append(el('h2', { class: 'dialog__title', id: titleId }, spec.title))

    let settled = false
    const settle = (result: T): void => {
      if (settled) return
      settled = true
      pendingCancels.delete(cancel)
      // 先关闭再摘除节点：否则页面上会残留一个不可见的空 <dialog>
      if (dialog.open) dialog.close()
      dialog.remove()
      resolve(result)
    }
    const cancel = (): void => settle(spec.cancelResult)
    pendingCancels.add(cancel)

    // Esc：原生 close 是“已关闭”的唯一信号；未结算就关闭的一律按取消收场
    dialog.addEventListener('close', cancel)
    // 遮罩点击：命中遮罩时事件 target 就是 <dialog> 自身（面板在其内部，target 为内部元素）
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) cancel()
    })

    const afterShow = spec.build({ dialog, panel, actions, settle })
    panel.append(actions)
    dialog.append(panel)
    document.body.append(dialog)
    dialog.showModal()
    afterShow()
  })
}

/** 打开二次确认弹窗：确认 true / 取消（含 Esc、点击遮罩）false */
export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  return createModal<boolean>({
    title: opts.title,
    cancelResult: false,
    build: ({ dialog, panel, actions, settle }) => {
      const messageId = nextId('dialog-message')
      panel.append(el('p', { class: 'dialog__message', id: messageId }, opts.message))
      // 正文是弹窗的语义补充，读屏时应与标题一起播报
      dialog.setAttribute('aria-describedby', messageId)

      const cancelBtn = el('button', { class: 'dialog__btn', type: 'button' }, '取消')
      cancelBtn.addEventListener('click', () => settle(false))

      const confirmBtn = el(
        'button',
        {
          class: `dialog__btn ${opts.danger === true ? 'dialog__btn--danger' : 'dialog__btn--primary'}`,
          type: 'button',
        },
        opts.confirmText ?? '确定',
      )
      confirmBtn.addEventListener('click', () => settle(true))

      // 焦点在按钮上时让浏览器走原生激活（回车 = 点击该按钮），
      // 焦点落在面板/弹窗本身时回车才由这里兜底为“确认”
      dialog.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        if (e.target instanceof HTMLButtonElement) return
        e.preventDefault()
        settle(true)
      })

      actions.append(cancelBtn, confirmBtn)
      // 默认聚焦确认按钮：回车即确认，与“主按钮”的视觉主次一致
      return () => confirmBtn.focus()
    },
  })
}

/** 打开文件名输入弹窗：确认返回输入值（已 trim）/ 取消返回 null */
export function promptDialog(opts: PromptDialogOptions): Promise<string | null> {
  return createModal<string | null>({
    title: opts.title,
    cancelResult: null,
    build: ({ panel, actions, settle }) => {
      const inputId = nextId('dialog-input')
      if (opts.label !== undefined && opts.label !== '') {
        panel.append(el('label', { class: 'dialog__label', for: inputId }, opts.label))
      }

      const input = el('input', {
        class: 'dialog__input',
        id: inputId,
        type: 'text',
        value: opts.defaultValue,
        autocomplete: 'off',
        spellcheck: 'false',
      })
      const errorEl = el('p', { class: 'dialog__error', role: 'alert' })

      const clearError = (): void => {
        errorEl.textContent = ''
        errorEl.classList.remove('is-visible')
        input.removeAttribute('aria-invalid')
      }
      const showError = (message: string): void => {
        errorEl.textContent = message
        errorEl.classList.add('is-visible')
        input.setAttribute('aria-invalid', 'true')
        // 出错的字段交回焦点，键盘用户不必再 Tab 回来
        input.focus()
      }

      const submit = (): void => {
        const value = input.value.trim()
        // 空值永远不通过：validate 只在其上追加校验，它的文案优先（便于按业务定制措辞）
        const custom = opts.validate?.(value) ?? null
        const error = custom ?? (value === '' ? '请输入文件名' : null)
        if (error !== null) {
          showError(error)
          return
        }
        settle(value)
      }

      const cancelBtn = el('button', { class: 'dialog__btn', type: 'button' }, '取消')
      cancelBtn.addEventListener('click', () => settle(null))

      const confirmBtn = el(
        'button',
        { class: 'dialog__btn dialog__btn--primary', type: 'button' },
        opts.confirmText ?? '确定',
      )
      confirmBtn.addEventListener('click', submit)

      input.addEventListener('keydown', (e) => {
        // 输入法组字中的回车用于上屏候选词，不能当成提交
        if (e.key !== 'Enter' || e.isComposing) return
        e.preventDefault()
        submit()
      })
      // 用户一改动，旧错误文案就已过期，先撤下（避免对着已修正的值继续报错）
      input.addEventListener('input', clearError)

      panel.append(input, errorEl)
      actions.append(cancelBtn, confirmBtn)
      // 打开即聚焦并全选：默认值通常是“原名 + 后缀”，全选便于直接覆写
      return () => {
        input.focus()
        input.select()
      }
    },
  })
}

/** 关闭当前打开的全部弹窗（工具卸载时兜底，未决 Promise 以取消收场） */
export function closeDialogs(): void {
  // 遍历副本：每个回调结算时都会把自己从集合里摘掉
  for (const cancel of [...pendingCancels]) cancel()
  pendingCancels.clear()
}
