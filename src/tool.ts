/** 工具接口：pianokits 是工具集，外壳（shell）通过此接口挂载/卸载各工具 */

export interface Tool {
  /** 稳定 id（用于工具注册表与切换状态） */
  id: string
  /** 顶栏显示的短名称 */
  name: string
  /**
   * 把工具内容挂载到 host；返回卸载函数（释放音频/定时器/观察器等资源）。
   * 同一时间只有一个工具被挂载，切换前外壳会先调用上一个工具的卸载函数。
   */
  mount(host: HTMLElement): (() => void) | Promise<() => void>
}
