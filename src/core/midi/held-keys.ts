/**
 * 当前按住键集合（Map：pitch → velocity）→ 音高升序列表（纯逻辑，可单测）。
 * 供“MIDI 键盘”调试工具多键并显；升序使 chips / 谱面位置稳定，与按下顺序无关。
 */
export function sortedHeldPitches(held: ReadonlyMap<number, number>): number[] {
  return [...held.keys()].sort((a, b) => a - b)
}
