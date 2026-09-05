import './style.css'
import { createShell } from './shell'

const root = document.querySelector<HTMLDivElement>('#app')

if (root === null) {
  throw new Error('#app root element not found')
}

createShell(root)
