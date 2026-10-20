import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Lives inside node_modules so a wiped or reinstalled node_modules also drops
// the stamp, which forces the next start to re-copy the checkout.
const STAMP_FILE = join('node_modules', '.typeclaw-local-source')

// Identifies the exact source a `file:` checkout would copy: committed HEAD plus
// uncommitted edits. Returns null when the checkout is not a Git repo, so the
// caller cannot tell whether the copy is stale and keeps its old behavior.
export async function localSourceFingerprint(sourceDir: string): Promise<string | null> {
  try {
    const git = async (...args: string[]) =>
      (await execFileAsync('git', ['-C', sourceDir, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout
    const [head, diff, untracked] = await Promise.all([
      git('rev-parse', 'HEAD'),
      git('diff', 'HEAD'),
      git('ls-files', '--others', '--exclude-standard'),
    ])
    // `git diff HEAD` skips untracked files, so hash their contents too: an edit
    // to a new, not-yet-added file must still count as a source change.
    const paths = untracked.split('\n').filter((path) => path !== '')
    const untrackedHashes =
      paths.length === 0
        ? ''
        : (
            await new Promise<string>((resolve, reject) => {
              const child = execFile(
                'git',
                ['-C', sourceDir, 'hash-object', '--stdin-paths'],
                { maxBuffer: 64 * 1024 * 1024 },
                (error, stdout) => (error ? reject(error) : resolve(stdout)),
              )
              child.stdin?.end(paths.join('\n'))
            })
          ).trim()
    return createHash('sha256')
      .update(head)
      .update('\0')
      .update(diff)
      .update('\0')
      .update(untracked)
      .update('\0')
      .update(untrackedHashes)
      .digest('hex')
  } catch {
    return null
  }
}

export async function readLocalSourceStamp(cwd: string): Promise<string | null> {
  try {
    return (await readFile(join(cwd, STAMP_FILE), 'utf8')).trim()
  } catch {
    return null
  }
}

export async function writeLocalSourceStamp(cwd: string, fingerprint: string): Promise<void> {
  const path = join(cwd, STAMP_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${fingerprint}\n`)
}
