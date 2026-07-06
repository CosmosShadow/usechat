import fs from 'node:fs'
import path from 'node:path'

const binPath = path.resolve('dist/index.js')
if (fs.existsSync(binPath)) {
  fs.chmodSync(binPath, 0o755)
}
