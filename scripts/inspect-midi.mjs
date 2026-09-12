/**
 * 开发/调查用：打印 MIDI 文件的轨与控制器事件概览（@tonejs/midi 视角）。
 * 用于确认「踏板 CC 落在哪条轨、该轨通道是什么」——踏板归属规则的实证工具，
 * 见 docs/development/research/20260912-midi-pedal-track-relationship.md。
 *
 * 用法：node scripts/inspect-midi.mjs <file.mid> [more.mid ...]
 */
import { readFileSync } from 'node:fs'
import toneMidi from '@tonejs/midi'

const { Midi } = toneMidi

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('用法：node scripts/inspect-midi.mjs <file.mid> [more.mid ...]')
  process.exit(1)
}

for (const path of files) {
  const midi = new Midi(readFileSync(path))
  console.log('=====', path)
  console.log(
    `ppq=${midi.header.ppq} duration=${midi.duration.toFixed(2)}s tracks=${midi.tracks.length}`,
  )
  midi.tracks.forEach((track, i) => {
    const counts = {}
    const channels = new Set()
    for (const key of Object.keys(track.controlChanges)) {
      const changes = track.controlChanges[key]
      counts[key] = changes.length
      for (const c of changes) channels.add(c.channel ?? 'n/a')
    }
    console.log(
      `  track ${i} name=${JSON.stringify(track.name)} ch=${track.channel} ` +
        `notes=${track.notes.length} ccs=${JSON.stringify(counts)} ccChannels=${[...channels].join(',')}`,
    )
    for (const cc of [64, 66, 67]) {
      const changes = track.controlChanges[cc]
      if (changes === undefined || changes.length === 0) continue
      const head = changes
        .slice(0, 6)
        .map((c) => `${c.time.toFixed(3)}s=${Math.round(c.value * 127)}`)
        .join(' ')
      console.log(`    CC${cc}: ${changes.length} events; first: ${head}`)
    }
  })
}
