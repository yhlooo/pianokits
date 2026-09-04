import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')

if (app === null) {
  throw new Error('#app root element not found')
}

app.innerHTML = `
  <main class="hello">
    <p class="hello__eyebrow">PianoKits</p>
    <h1>Hello, World!</h1>
    <p class="hello__hint">TypeScript + Vite 就绪 — 编辑 <code>src/main.ts</code> 开始开发</p>
  </main>
`
