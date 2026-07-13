import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const courseRoot = path.join(repoRoot, 'course')

const theoryDirectories = [
  'basics',
  'process',
  'concurrency',
  'memory',
  'network',
  'storage',
  'filesystem',
  'security',
  'virtualization',
  'observability',
]

const expectedLessonCount = 32
const errors = []
const warnings = []

function report(target, relativePath, line, message) {
  target.push(`${relativePath}:${line}: ${message}`)
}

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function normalizeConcept(value) {
  return value.replaceAll('`', '').replace(/\s+/g, ' ').trim()
}

function proseLines(source) {
  const lines = source.split('\n')
  const result = []
  let fence = null

  for (const line of lines) {
    const trimmed = line.trim()
    const fenceMatch = trimmed.match(/^(```+|~~~+)/)

    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (trimmed[0] === fence) fence = null
      result.push('')
      continue
    }

    result.push(fence === null ? line : '')
  }

  return result
}

function collectLessons() {
  const lessons = []

  for (const directory of theoryDirectories) {
    const absoluteDirectory = path.join(courseRoot, directory)
    for (const entry of readdirSync(absoluteDirectory).sort()) {
      if (!entry.endsWith('.md')) continue
      lessons.push(path.join(absoluteDirectory, entry))
    }
  }

  return lessons
}

function inspectContainersAndFences(source, relativePath) {
  const lines = source.split('\n')
  const containerStack = []
  const disallowedLanguages = new Set([
    'go',
    'javascript',
    'js',
    'python',
    'rust',
    'typescript',
    'ts',
    'zig',
  ])
  let fence = null
  let lastClosedContainer = null
  let proseSinceContainer = true

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    const fenceMatch = trimmed.match(/^(```+|~~~+)\s*([^\s{]*)/)

    if (fenceMatch) {
      if (fence === null) {
        fence = fenceMatch[1][0]
        const language = fenceMatch[2].toLowerCase()
        if (
          disallowedLanguages.has(language) &&
          !containerStack.includes('expand')
        ) {
          report(
            errors,
            relativePath,
            index + 1,
            `${language} 代码必须放在 expand 容器中`
          )
        }
      } else if (trimmed[0] === fence) {
        fence = null
      }
      continue
    }

    if (fence !== null) continue

    const openContainer = trimmed.match(/^:::(expand|thinking|practice)\b/)
    if (openContainer) {
      const type = openContainer[1]
      if (type === 'practice') {
        report(
          errors,
          relativePath,
          index + 1,
          '理论课不得包含 practice 容器，实践内容应放入项目课'
        )
      }
      if (lastClosedContainer === type && !proseSinceContainer) {
        report(
          errors,
          relativePath,
          index + 1,
          `不能连续使用两个 ${type} 容器`
        )
      }
      containerStack.push(type)
      lastClosedContainer = null
      proseSinceContainer = false
      continue
    }

    if (trimmed === ':::') {
      lastClosedContainer = containerStack.pop() ?? null
      proseSinceContainer = false
      continue
    }

    if (
      containerStack.length === 0 &&
      trimmed !== '' &&
      !trimmed.startsWith('<!--')
    ) {
      proseSinceContainer = true
    }
  }
}

function inspectLinksAndImports(source, relativePath) {
  for (const match of source.matchAll(/\]\((\/[^)#?]+)(?:#[^)]*)?\)/g)) {
    const target = match[1]
    const absoluteTarget =
      target === '/'
        ? path.join(courseRoot, 'index.md')
        : path.join(courseRoot, `${target.slice(1)}.md`)

    if (!existsSync(absoluteTarget)) {
      report(
        errors,
        relativePath,
        lineNumberAt(source, match.index),
        `内部链接不存在: ${target}`
      )
    }
  }

  for (const match of source.matchAll(/^<<<\s+@\/([^\s{]+).*$/gm)) {
    const absoluteTarget = path.join(courseRoot, match[1])
    if (!existsSync(absoluteTarget)) {
      report(
        errors,
        relativePath,
        lineNumberAt(source, match.index),
        `代码导入不存在: @/${match[1]}`
      )
    }
  }
}

function inspectLesson(absolutePath) {
  const relativePath = path.relative(repoRoot, absolutePath)
  const source = readFileSync(absolutePath, 'utf8')
  const lines = source.split('\n')
  const visibleLines = proseLines(source)

  const h1 = visibleLines.filter((line) => line.startsWith('# '))
  if (h1.length !== 1) {
    report(errors, relativePath, 1, `应当恰好有一个 h1，实际为 ${h1.length}`)
  }

  if (!/^- 写作时间：`[^`]+`$/m.test(source)) {
    report(errors, relativePath, 1, '缺少写作时间元信息')
  }
  if (!/^- 当前字符：`\d+`$/m.test(source)) {
    report(errors, relativePath, 1, '缺少自动字符数元信息')
  }
  if (/^- (?:作者|协作者)：/m.test(source)) {
    report(errors, relativePath, 1, '课程元信息不应包含作者或协作者')
  }
  if (source.includes('本篇正在编写中。')) {
    report(errors, relativePath, 1, '理论课仍包含未完成占位')
  }

  for (let index = 0; index < visibleLines.length; index += 1) {
    if (visibleLines[index].startsWith('### ')) {
      report(errors, relativePath, index + 1, '理论课不使用 h3')
    }
    if (visibleLines[index].includes('—')) {
      report(errors, relativePath, index + 1, '正文禁止使用破折号')
    }
  }

  const headings = []
  for (let index = 0; index < visibleLines.length; index += 1) {
    const match = visibleLines[index].match(/^## (.+)$/)
    if (match) headings.push({ title: match[1].trim(), line: index + 1, index })
  }

  const summaries = headings.filter((heading) => heading.title === '小结')
  if (summaries.length !== 1) {
    report(errors, relativePath, 1, `应当恰好有一个“小结”，实际为 ${summaries.length}`)
  } else if (headings.at(-1)?.title !== '小结') {
    report(errors, relativePath, summaries[0].line, '“小结”必须是最后一个 h2')
  }

  const knowledgeHeadings = headings.filter((heading) => heading.title !== '小结')
  if (knowledgeHeadings.length < 4 || knowledgeHeadings.length > 7) {
    report(
      errors,
      relativePath,
      1,
      `知识节数量应为 4–7，实际为 ${knowledgeHeadings.length}`
    )
  }

  for (let headingIndex = 0; headingIndex < knowledgeHeadings.length; headingIndex += 1) {
    const heading = knowledgeHeadings[headingIndex]
    const nextHeading = headings.find((candidate) => candidate.index > heading.index)
    const end = nextHeading?.index ?? lines.length
    const firstBodyLine = lines
      .slice(heading.index + 1, end)
      .findIndex((line) => line.trim() !== '')

    if (firstBodyLine < 0) {
      report(errors, relativePath, heading.line, '知识节缺少正文定义句')
      continue
    }

    const absoluteLine = heading.index + 1 + firstBodyLine
    const first = lines[absoluteLine].trim()
    if (
      first.startsWith('#') ||
      first.startsWith('- ') ||
      first.startsWith('|') ||
      first.startsWith('```') ||
      first.startsWith(':::')
    ) {
      report(
        errors,
        relativePath,
        absoluteLine + 1,
        `“${heading.title}”的第一句必须是正文定义句`
      )
    }
  }

  if (summaries.length === 1) {
    const summaryStart = summaries[0].index
    if (!lines.slice(summaryStart + 1).some((line) => /^\|.+\|$/.test(line))) {
      report(errors, relativePath, summaries[0].line, '小结缺少概念汇总表')
    }
  }

  const firstHeadingIndex = knowledgeHeadings[0]?.index ?? lines.length
  const opening = visibleLines.slice(0, firstHeadingIndex).join('\n')
  const openingConcepts = [
    ...opening.matchAll(/\*\*([^*\n]+)\*\*/g),
  ].map((match) => normalizeConcept(match[1]))
  const headingConcepts = knowledgeHeadings.map((heading) =>
    normalizeConcept(heading.title)
  )

  const missingFromOpening = headingConcepts.filter(
    (heading) => !openingConcepts.includes(heading)
  )
  const extraInOpening = openingConcepts.filter(
    (concept) => !headingConcepts.includes(concept)
  )

  if (missingFromOpening.length > 0 || extraInOpening.length > 0) {
    report(
      warnings,
      relativePath,
      1,
      `开篇概念与 h2 不一致；缺少 [${missingFromOpening.join(', ')}]，多出 [${extraInOpening.join(', ')}]`
    )
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (/(?<!我)我(?!们)/.test(lines[index])) {
      report(warnings, relativePath, index + 1, '检查是否可以把“我”改为“我们”或客观主语')
    }
    if (/第[一二三四五六七八九十0-9]+(?:篇|课)/.test(lines[index])) {
      report(warnings, relativePath, index + 1, '避免依赖具体篇号或课号回引')
    }
    if (/(?:上一课|下一课|上一篇|下一篇|上一章|下一章)/.test(visibleLines[index])) {
      report(
        errors,
        relativePath,
        index + 1,
        '跨课衔接必须使用具体课程名或链接，不能只写上一课、下一课、上一章或下一章'
      )
    }
  }

  inspectContainersAndFences(source, relativePath)
  inspectLinksAndImports(source, relativePath)
}

const lessons = collectLessons()
if (lessons.length !== expectedLessonCount) {
  errors.push(`理论课总数应为 ${expectedLessonCount}，实际为 ${lessons.length}`)
}

for (const lesson of lessons) inspectLesson(lesson)

for (const warning of warnings) console.warn(`warning: ${warning}`)
for (const error of errors) console.error(`error: ${error}`)

if (errors.length > 0) {
  console.error(`\n审查失败：${errors.length} 个错误，${warnings.length} 个提醒`)
  process.exit(1)
}

console.log(`审查通过：${lessons.length} 门理论课，${warnings.length} 个提醒`)
