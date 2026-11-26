import { execSync } from 'node:child_process'
import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dns.setDefaultResultOrder('ipv4first')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const REPO = process.env.GITHUB_RECORDER_REPO || 'mmody111222/hls-worker'
const BRANCH = 'main'

async function fetchWithRetry(url, init = {}, attempts = 3) {
  let lastErr = null
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, init)
      if ((res.status === 502 || res.status === 503 || res.status === 504) && i < attempts) {
        await new Promise((r) => setTimeout(r, 1000 * i))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 1000 * i))
      }
    }
  }
  const cause = lastErr?.cause ? ` (${lastErr.cause.message || lastErr.cause})` : ''
  throw new Error(`${lastErr?.message || 'fetch failed'}${cause}`)
}

const FILE_MAP = [
  { local: 'requirements.txt', remote: 'requirements.txt', mode: '100644' },
  { local: 'recorder.py', remote: 'recorder.py', mode: '100644' },
  { local: 'uploader.py', remote: 'uploader.py', mode: '100644' },
  { local: 'trim.py', remote: 'trim.py', mode: '100644' },
  { local: 'frame.py', remote: 'frame.py', mode: '100644' },
  { local: 'sidecar/plugins/stripchat.py', remote: 'plugins/stripchat.py', mode: '100644' },
  { local: '.github/workflows/record.yml', remote: '.github/workflows/record.yml', mode: '100644' },
  { local: '.github/workflows/trim.yml', remote: '.github/workflows/trim.yml', mode: '100644' },
  { local: '.github/workflows/frame.yml', remote: '.github/workflows/frame.yml', mode: '100644' },
]

function resolveToken() {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim()
  try {
    const remoteUrl = execSync('git remote get-url origin', { cwd: ROOT, encoding: 'utf8' }).trim()
    const match = remoteUrl.match(/^https:\/\/(?:[^:@]+:)?([^@]+)@github\.com\//i)
    if (match?.[1]) return match[1]
  } catch {
    // Ignore git lookup error; handled below.
  }
  throw new Error('GITHUB_TOKEN not set and no embedded token found in git origin remote URL.')
}

async function ghJson(token, endpoint, init = {}) {
  const res = await fetchWithRetry(`https://api.github.com/repos/${REPO}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'savelink-sync-recorder',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (!res.ok) {
    const msg = typeof parsed === 'object' && parsed?.message ? parsed.message : String(parsed)
    const err = new Error(`GitHub API ${res.status} on ${endpoint}: ${msg}`)
    err.status = res.status
    throw err
  }
  return parsed
}

async function fetchRemoteRaw(token, remotePath, ref = BRANCH) {
  const res = await fetchWithRetry(`https://api.github.com/repos/${REPO}/contents/${remotePath}?ref=${encodeURIComponent(ref)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'savelink-sync-recorder',
      Accept: 'application/vnd.github.v3.raw',
    },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed reading ${remotePath}: HTTP ${res.status}`)
  return (await res.text()).replace(/\r\n/g, '\n')
}

async function pushFiles(token, filesToPush, parentSha, baseTreeSha) {
  const treeEntries = []
  for (const item of filesToPush) {
    const blob = await ghJson(token, '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: item.content, encoding: 'utf-8' }),
    })
    treeEntries.push({
      path: item.remote,
      mode: item.mode,
      type: 'blob',
      sha: blob.sha,
    })
  }

  const tree = await ghJson(token, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  })

  const savelinkSha = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  const commit = await ghJson(token, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `sync: align recorder and workflow scripts with savelink (${savelinkSha})`,
      tree: tree.sha,
      parents: [parentSha],
    }),
  })

  await ghJson(token, `/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  })
  return commit.sha
}

async function main() {
  const token = resolveToken()
  const prepared = FILE_MAP.map((entry) => {
    const abs = path.join(ROOT, entry.local)
    const content = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
    return { ...entry, content }
  })

  const changed = []
  for (const item of prepared) {
    const remoteContent = await fetchRemoteRaw(token, item.remote)
    if (remoteContent !== item.content) changed.push(item)
  }

  if (!changed.length) {
    console.log(`All ${prepared.length} files in ${REPO} already match savelink.`)
    return
  }

  let ref = null
  let headCommit = null
  try {
    ref = await ghJson(token, `/git/ref/heads/${BRANCH}`)
    headCommit = await ghJson(token, `/git/commits/${ref.object.sha}`)
  } catch (err) {
    if (err.status === 404 || err.status === 409) {
      await ghJson(token, '/contents/README.md', {
        method: 'PUT',
        body: JSON.stringify({
          message: 'chore: initialize hls-worker',
          content: Buffer.from('# hls-worker\n\nHLS educational stream worker.\n', 'utf8').toString('base64'),
          branch: BRANCH,
        }),
      })
      ref = await ghJson(token, `/git/ref/heads/${BRANCH}`)
      headCommit = await ghJson(token, `/git/commits/${ref.object.sha}`)
    } else {
      throw err
    }
  }

  let pushed = changed
  let newSha
  try {
    newSha = await pushFiles(token, changed, headCommit.sha, headCommit.tree.sha)
  } catch (err) {
    const touchesWorkflow = changed.some((f) => f.remote.startsWith('.github/workflows/'))
    if (touchesWorkflow && (err.status === 403 || err.status === 422)) {
      console.warn(`Workflow push rejected (${err.message}); retrying without .github/workflows/*`)
      pushed = changed.filter((f) => !f.remote.startsWith('.github/workflows/'))
      if (!pushed.length) throw err
      newSha = await pushFiles(token, pushed, headCommit.sha, headCommit.tree.sha)
    } else {
      throw err
    }
  }

  for (const item of pushed) {
    const verified = await fetchRemoteRaw(token, item.remote, newSha)
    if (verified !== item.content) {
      throw new Error(`Verification mismatch after push for ${item.remote}`)
    }
  }

  console.log(`Synced ${pushed.length} file(s) to ${REPO}@${newSha.slice(0, 7)}:`)
  for (const item of pushed) console.log(`  - ${item.remote}`)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
