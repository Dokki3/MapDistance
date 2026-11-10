import { spawn } from 'node:child_process'

const node = process.execPath
const server = spawn(node, ['server/index.mjs'], { stdio: 'inherit' })
const vite = spawn(node, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173'], {
  stdio: 'inherit',
})

function stop() {
  server.kill('SIGTERM')
  vite.kill('SIGTERM')
  process.exit(0)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
server.on('exit', (code) => {
  if (code) {
    vite.kill('SIGTERM')
    process.exit(code)
  }
})
