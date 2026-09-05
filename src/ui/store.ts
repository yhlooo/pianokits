/** 轻量发布订阅 store：视图订阅离散状态变化；连续量（播放位置）不经 store（设计文档 §3.3） */

export class Store<T extends object> {
  private state: T
  private listeners = new Set<() => void>()

  constructor(initial: T) {
    this.state = initial
  }

  get(): T {
    return this.state
  }

  update(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  set(next: T): void {
    this.state = next
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}

/** 视图公共接口：每个视图负责自己的一块 DOM，订阅 store 并按需重绘 */
export interface View {
  readonly el: HTMLElement
}
