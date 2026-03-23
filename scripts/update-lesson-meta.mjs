import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const targetDir = path.join(repoRoot, 'course')
const today = execFileSync('date', ['+%F'], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

const metaPattern =
  /(^# .+\n\n)(?:- 协作者：`[^`\n]*`\n)?- 写作时间：`[^`\n]*`\n- 当前字符：`[^`\n]*`/m
const headerPattern = /^# .+\n\n/

function runGit(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    if (allowFailure) return ''
    throw error
  }
}

function hasWorkingTreeChanges(relativePath) {
  const status = runGit(['status', '--porcelain', '--', relativePath], { allowFailure: true })
  return status.length > 0
}

function isUnstartedLesson(source) {
  return source.includes('本篇正在编写中。') && !source.includes('\n## ')
}

function getDateText(relativePath, source) {
  if (isUnstartedLesson(source)) return '未开始'

  const history = runGit(
    ['log', '--follow', '--format=%ad', '--date=short', '--', relativePath],
    { allowFailure: true }
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const created = history.at(-1) ?? today
  const needsInitialMeta = !metaPattern.test(source)
  const updated =
    hasWorkingTreeChanges(relativePath) || needsInitialMeta
      ? today
      : history[0] ?? today

  if (created === updated) return created
  return `${created} 首次提交，${updated} 最近修改`
}

function countCharacters(text) {
  return Array.from(text).length
}

function renderMetaBlock(dateText, charCount) {
  return [
    `- 写作时间：\`${dateText}\``,
    `- 当前字符：\`${charCount}\``,
  ].join('\n')
}

function collectMarkdownFiles(dir) {
  const entries = readdirSync(dir).sort()
  const files = []

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry)
    const stats = statSync(absolutePath)

    if (stats.isDirectory()) {
      files.push(...collectMarkdownFiles(absolutePath))
      continue
    }

    if (!entry.endsWith('.md')) continue
    files.push(absolutePath)
  }

  return files
}

function applyMetaBlock(source, dateText, charCount) {
  const renderedMeta = renderMetaBlock(dateText, charCount)

  if (metaPattern.test(source)) {
    return source.replace(metaPattern, `$1${renderedMeta}`)
  }

  if (headerPattern.test(source)) {
    return source.replace(headerPattern, (header) => `${header}${renderedMeta}\n\n`)
  }

  return source
}

for (const absolutePath of collectMarkdownFiles(targetDir)) {
  const relativePath = path.relative(repoRoot, absolutePath)
  const source = readFileSync(absolutePath, 'utf8')

  if (!metaPattern.test(source) && !headerPattern.test(source)) continue

  const dateText = getDateText(relativePath, source)

  let charCount = 0
  let rendered = source

  for (let i = 0; i < 8; i += 1) {
    rendered = applyMetaBlock(source, dateText, charCount)
    const next = countCharacters(rendered)
    if (next === charCount) break
    charCount = next
  }

  rendered = applyMetaBlock(source, dateText, charCount)

  writeFileSync(absolutePath, rendered)
}
