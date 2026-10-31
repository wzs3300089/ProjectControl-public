import React from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectConsole } from './client/panel.js'
import { readCodexProjects } from './client/api.js'

class ConsoleBoundary extends React.Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) return React.createElement('div', { className: 'connection-error', role: 'alert' },
      '总控台显示失败：', this.state.error.message,
      React.createElement('button', { onClick: () => location.reload() }, '重新打开'))
    return this.props.children
  }
}

export async function mountConsole() {
  let codexContext = null, codexError = ''
  try { codexContext = await readCodexProjects({ onOpen: true }) }
  catch (error) { codexError = error.message || '读取 Codex 项目绑定失败。' }
  createRoot(document.getElementById('root')).render(
    React.createElement(ConsoleBoundary, null, React.createElement(ProjectConsole, { codexContext, codexError })))
}
