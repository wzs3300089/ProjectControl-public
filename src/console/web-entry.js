import { configureTransport, ApiError } from './client/api.js'
import { mountConsole } from './mount.js'

configureTransport({
  async call(name, args) {
    const response = await fetch('/api/project-console/tool', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ name, arguments: args }),
    })
    const value = await response.json()
    if (!response.ok) throw new ApiError(value.error || '请求失败', response.status)
    return value
  },
})
await mountConsole()
