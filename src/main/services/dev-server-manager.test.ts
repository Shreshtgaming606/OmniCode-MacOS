import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DevServerManager } from './dev-server-manager'

const temporaryRoots: string[] = []
const servers: DevServerManager[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('static development server', () => {
  it('serves project assets but refuses credentials and metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicode-server-'))
    temporaryRoots.push(root)
    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, 'index.html'), '<main>OmniCode</main>')
    await fs.writeFile(path.join(root, 'public.txt'), 'safe')
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret')
    await fs.writeFile(path.join(root, '.git', 'config'), '[remote]')

    const server = new DevServerManager()
    servers.push(server)
    const state = await server.start(root)
    expect(state.url).toBeTruthy()
    expect(await fetch(`${state.url}/public.txt`).then((response) => response.text())).toBe('safe')
    expect((await fetch(`${state.url}/.env`)).status).toBe(403)
    expect((await fetch(`${state.url}/.git/config`)).status).toBe(403)
  })
})
