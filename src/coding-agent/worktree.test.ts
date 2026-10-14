import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureCodingChanges, createCodingWorkspace, runCodingProcess, type CodingExecutor } from './worktree'

let root: string
let source: string
let task: string
let execute: CodingExecutor
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'coding-worktree-')))
  source = join(root, 'source')
  task = join(root, 'task')
  await mkdir(source)
  await mkdir(join(task, 'output'), { recursive: true })
  execute = (argv, cwd, env) =>
    runCodingProcess(argv, cwd, {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      ...env,
    })
  await execute(['git', 'init', source], root)
  for (const file of ['staged', 'unstaged', 'deleted', 'mode']) await writeFile(join(source, file), 'base\n')
  await execute(['git', 'add', '.'], source)
  await execute(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], source)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// Snapshot integration requires POSIX Git paths, shell scripts and Unix file modes.
describe.skipIf(process.platform === 'win32')('task-private worktree', () => {
  test('reconstructs staged, unstaged, untracked, deletion, binary, symlink and mode changes without touching the source', async () => {
    const sourceIndex = await readFile(join(source, '.git', 'index'))
    const workspace = await createCodingWorkspace(source, task, execute, source)
    const cwd = join(task, 'worktree')
    await writeFile(join(cwd, 'staged'), 'staged\n')
    await execute(['git', 'add', 'staged'], cwd)
    await writeFile(join(cwd, 'unstaged'), '작업 완료\n')
    await rm(join(cwd, 'deleted'))
    await chmod(join(cwd, 'mode'), 0o755)
    await writeFile(join(cwd, 'new'), 'new\n')
    await writeFile(join(cwd, 'binary'), Buffer.from([0, 255, 1, 2]))
    await symlink('new', join(cwd, 'link'))
    const childIndex = await readFile(join(task, 'git', 'worktrees', 'worktree', 'index'))
    const artifacts = await captureCodingChanges(workspace, execute, (path, text) => writeFile(path, text))
    expect(artifacts.changedFiles.toSorted()).toEqual([
      'binary',
      'deleted',
      'link',
      'mode',
      'new',
      'staged',
      'unstaged',
    ])
    expect(artifacts.untrackedFiles.toSorted()).toEqual(['binary', 'link', 'new'])
    const inventory = JSON.parse(await readFile(join(task, 'output', 'changes.json'), 'utf8'))
    expect(inventory.changes).toContainEqual({
      path: 'binary',
      status: 'A',
      oldMode: '000000',
      mode: '100644',
      binary: true,
      untracked: true,
    })
    expect(inventory.changes).toContainEqual({
      path: 'link',
      status: 'A',
      oldMode: '000000',
      mode: '120000',
      binary: false,
      untracked: true,
    })
    expect(await readFile(join(source, '.git', 'index'))).toEqual(sourceIndex)
    expect(await readFile(join(task, 'git', 'worktrees', 'worktree', 'index'))).toEqual(childIndex)
    expect(await execute(['git', 'status', '--porcelain'], source)).toBe('')
    const applied = join(root, 'applied')
    await execute(['git', 'clone', '--no-hardlinks', source, applied], root)
    await execute(['git', 'apply', '--binary', artifacts.patchPath], applied)
    expect(await readFile(join(applied, 'binary'))).toEqual(Buffer.from([0, 255, 1, 2]))
    expect(await readFile(join(applied, 'unstaged'), 'utf8')).toBe('작업 완료\n')
    expect(await readlink(join(applied, 'link'))).toBe('new')
    expect((await lstat(join(applied, 'mode'))).mode & 0o111).not.toBe(0)
    await expect(lstat(join(applied, 'deleted'))).rejects.toThrow()
    expect(await execute(['git', '--git-dir', join(task, 'git'), 'remote'], task)).toBe('')
    await expect(lstat(join(task, 'git', 'objects', 'info', 'alternates'))).rejects.toThrow()
  })

  test('imports committed HEAD from Git metadata without exposing the dirty source worktree', async () => {
    await writeFile(join(source, 'unstaged'), 'excluded\n')
    await writeFile(join(source, 'untracked'), 'excluded\n')
    const gitOnly = join(root, 'git-only')
    await mkdir(gitOnly)
    await cp(join(source, '.git'), join(gitOnly, '.git'), { recursive: true })
    const workspace = await createCodingWorkspace(source, task, execute, gitOnly)
    expect(workspace.baseSha).toBe((await execute(['git', 'rev-parse', 'HEAD'], source)).trim())
    expect(await readFile(join(task, 'worktree', 'unstaged'), 'utf8')).toBe('base\n')
    await expect(lstat(join(task, 'worktree', 'untracked'))).rejects.toThrow()
  })

  test('replacement refs cannot redefine the recorded patch baseline', async () => {
    const workspace = await createCodingWorkspace(source, task, execute, source)
    const cwd = join(task, 'worktree')
    await writeFile(join(cwd, 'staged'), 'changed\n')
    await execute(['git', 'add', '.'], cwd)
    await execute(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'child'], cwd)
    const changed = (await execute(['git', 'rev-parse', 'HEAD'], cwd)).trim()
    await execute(['git', 'replace', workspace.baseSha, changed], cwd)
    const artifacts = await captureCodingChanges(workspace, execute, (path, text) => writeFile(path, text))
    expect(artifacts.changedFiles).toContain('staged')
    expect(await readFile(artifacts.patchPath, 'utf8')).toContain('+changed')
  })

  test('captures tracked edits hidden by either or both index flags without changing the CLI index', async () => {
    const workspace = await createCodingWorkspace(source, task, execute, source)
    const cwd = join(task, 'worktree')
    await execute(['git', 'update-index', '--assume-unchanged', 'staged', 'mode'], cwd)
    await execute(['git', 'update-index', '--skip-worktree', 'unstaged', 'mode'], cwd)
    await writeFile(join(cwd, 'staged'), 'assumed edit\n')
    await writeFile(join(cwd, 'unstaged'), 'skipped edit\n')
    await writeFile(join(cwd, 'mode'), 'both flags\n')
    const indexPath = join(task, 'git', 'worktrees', 'worktree', 'index')
    const childIndex = await readFile(indexPath)

    const artifacts = await captureCodingChanges(workspace, execute, (path, text) => writeFile(path, text))

    expect(artifacts.changedFiles.toSorted()).toEqual(['mode', 'staged', 'unstaged'])
    const patch = await readFile(artifacts.patchPath, 'utf8')
    expect(patch).toContain('+assumed edit')
    expect(patch).toContain('+skipped edit')
    expect(patch).toContain('+both flags')
    expect(await readFile(indexPath)).toEqual(childIndex)
  })

  test('includes committed and staged new files even when later ignored', async () => {
    const workspace = await createCodingWorkspace(source, task, execute, source)
    const cwd = join(task, 'worktree')
    await writeFile(join(cwd, 'committed-new'), 'committed\n')
    await execute(['git', 'add', '.'], cwd)
    await execute(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'child'], cwd)
    await writeFile(join(cwd, 'staged-new'), 'staged\n')
    await execute(['git', 'add', '.'], cwd)
    await writeFile(join(cwd, '.gitignore'), '*-new\n')
    const artifacts = await captureCodingChanges(workspace, execute, (path, text) => writeFile(path, text))
    const patch = await readFile(artifacts.patchPath, 'utf8')
    expect(patch).toContain('committed-new')
    expect(patch).toContain('staged-new')
  })

  test('rejects protected paths in the selected revision only', async () => {
    const clean = (await execute(['git', 'rev-parse', 'HEAD'], source)).trim()
    await writeFile(join(source, 'secrets.json'), 'fixture-canary')
    await execute(['git', 'add', '.'], source)
    await execute(
      ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'protected'],
      source,
    )
    const protectedRevision = (await execute(['git', 'rev-parse', 'HEAD'], source)).trim()
    await execute(['git', 'replace', protectedRevision, clean], source)
    await expect(createCodingWorkspace(source, task, execute, source)).rejects.toThrow('protected')
    await execute(['git', 'replace', '-d', protectedRevision], source)
    await execute(['git', 'rm', 'secrets.json'], source)
    await execute(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'clean'], source)
    expect((await createCodingWorkspace(source, task, execute, source)).baseSha).toMatch(/^[a-f0-9]{40}$/)
  })

  test('snapshots a read-only source without modifying its Git administration', async () => {
    const index = await readFile(join(source, '.git', 'index'))
    await chmod(source, 0o555)
    await chmod(join(source, '.git'), 0o555)
    try {
      const workspace = await createCodingWorkspace(source, task, execute, source)
      expect(workspace.baseSha).toMatch(/^[a-f0-9]{40}$/)
      expect(await readFile(join(source, '.git', 'index'))).toEqual(index)
    } finally {
      await chmod(source, 0o755)
      await chmod(join(source, '.git'), 0o755)
    }
  })
})
