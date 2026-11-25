import { atom, read, update } from 'claude-code'
import type { ModelCompleteResult, Register } from 'claude-code'

import type { ChangedFile, Suggestion } from '../types'

const PANE = 'session-hub'
const REFINE_RULES ='Rewrite the users input into the shortest effective prompt that achieves their intent. Preserve meaning, fix ambiguity only when necessary, and avoid adding assumptions, instructions, sections, or requirements. Use GOAL, DOs, DONTs, OUTPUT FORMAT, and TODO only when genuinely needed. Return only the refined prompt.'

// The request sent to the model: the draft, clearly marked as the text to rewrite.
const refinementRequest = (text: string): string => `Rewrite the draft between the markers.\n<<<\n${text}\n>>>`

// Removes the wrapping a model adds around a rewrite: a preamble line such as "Here is the
// rewritten prompt:", and quotation marks around the whole text.
export const cleanRefinement = (reply: string): string => {
  let text = reply.trim().replace(/^here(?:'s| is)[^\n]*?:\s*/i, '').replace(/\s*\(note[\s\S]*\)\s*$/i, '').trim()
  if (text.length >= 2 && /^["'“‘]/.test(text) && /["'”’]$/.test(text)) {
    text = text.slice(1, -1).trim()
  }

  return text
}
// Whether a model reply is a usable rewrite: not empty, and not a refusal or commentary.
export const isUsableRefinement = (reply: string): boolean => {
  const normal = reply.trim()
  if (normal === '') return false

  return !/^(i('m| am)? (not|unable|sorry)|i can(not|'t)|i won'?t|sorry|as an ai)/i.test(normal) &&
    !/instruction|system/i.test(normal)
}
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const DELETE_COMMANDS = new Set(['rm', 'del', 'erase', 'rmdir', 'remove-item'])
const MAX_FILES = 200
const MAX_PROJECT_ROWS = 40
const MAX_PROJECT_DEPTH = 3
const SKIP_DIRS = new Set(['node_modules'])
// How long the prompt box must stay unchanged before it is refined.
const REFINE_PAUSE_MS = 3000

type ProjectRow = {
  id: string
  label: string
  name: string
  prefix: string
  kind: 'folder' | 'file'
  canExpand: boolean
  open: boolean
  change: ChangedFile['kind'] | null
}

type TreeEntry = {
  name: string
  isDir: boolean
  change: ChangedFile['kind'] | null
}

const isRefining = atom({ plugin: 'session-hub', key: 'isRefining' } as const, true, {
  shape: 'refine-1',
})
const files = atom({ plugin: 'session-hub', key: 'files' } as const, [] as ChangedFile[], {
  shape: 'files-1',
})
// Folders closed one by one, while every folder is open by default.
const collapsed = atom({ plugin: 'session-hub', key: 'collapsed' } as const, [] as string[], {
  shape: 'collapsed-1',
})
// "Collapse all" closes every folder below the first level; `expanded` lists the ones opened again.
const collapsedAll = atom({ plugin: 'session-hub', key: 'collapsedAll' } as const, true, {
  shape: 'collapsed-all-1',
})
const expanded = atom({ plugin: 'session-hub', key: 'expanded' } as const, [] as string[], {
  shape: 'expanded-1',
})
const promptAt = atom({ plugin: 'session-hub', key: 'promptAt' } as const, 0, {
  shape: 'prompt-at-1',
})
const selected = atom({ plugin: 'session-hub', key: 'selected' } as const, '', {
  shape: 'selected-1',
})
const tick = atom({ plugin: 'session-hub', key: 'tick' } as const, 0, {
  shape: 'tick-1',
})
// The project tree as last read, as JSON; '' until the first read.
const treeSnapshot = atom({ plugin: 'session-hub', key: 'treeSnapshot' } as const, '', {
  shape: 'tree-snapshot-1',
})
// What is typed in the tree's search box.
const treeFilter = atom({ plugin: 'session-hub', key: 'treeFilter' } as const, '', {
  shape: 'tree-filter-1',
})
// The first tree row the explorer shows; it scrolls by moving this.
const searchOpen = atom({ plugin: 'session-hub', key: 'searchOpen' } as const, false, {
  shape: 'search-open-1',
})
const treeOffset = atom({ plugin: 'session-hub', key: 'treeOffset' } as const, 0, {
  shape: 'tree-offset-1',
})
// The refined suggestion for one draft, shown in the pane; null when none.
const suggestion = atom({ plugin: 'session-hub', key: 'suggestion' } as const, null as Suggestion | null, {
  shape: 'suggestion-1',
})
// The text in the prompt box as the refiner last saw it.
const currentDraft = atom({ plugin: 'session-hub', key: 'currentDraft' } as const, '', {
  shape: 'current-draft-1',
})// What the refiner last did, shown under the refine toggle.
const refineStatus = atom(
  { plugin: 'session-hub', key: 'refineStatus' } as const,
  'Idle',
  { shape: 'refine-status-1' },
)

// The label of a rate limit: a known name, or the limit's own name with its underscores as spaces.
export const limitName = (kind: string): string => {
  const known: Record<string, string> = { five_hour: '5-hour limit', seven_day: '7-day limit' }

  return known[kind] ?? kind.replace(/_/g, ' ')
}
// A short name for a limit row: 5h, 7d, or the limit's own name.
export const shortLimitName = (kind: string): string => {
  const known: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

  return known[kind] ?? kind.replace(/_/g, ' ')
}
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

// Adds `id` to a list, or takes it out when it is already there.
const toggleIn = (id: string) => (list: string[]) =>
  list.includes(id) ? list.filter(item => item !== id) : [...list, id]

// Paths a shell command deletes, read from the arguments of rm / del / Remove-Item. Quoted
// arguments keep their spaces; flags are skipped.
export const deletedPaths = (command: string): string[] =>
  command.split(/&&|\|\||;|\|/).flatMap(part => {
    const words = [...part.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
    const [cmd, ...args] = words
    if (!cmd || !DELETE_COMMANDS.has(cmd.toLowerCase())) return []

    return args.filter(arg => arg !== '' && !arg.startsWith('-'))
  })
// Usage meters: the bar's width in cells, and the levels at which a meter turns yellow and red.
const METER_WIDTH = 10
const USAGE_WARN_PCT = 70
const USAGE_ALERT_PCT = 90

// A usage percentage kept within 0..100; undefined when there is no usable number.
export const clampPct = (value: number | undefined): number | undefined =>
  value === undefined || Number.isNaN(value) ? undefined : Math.min(100, Math.max(0, value))

// The filled and empty parts of a bar showing `pct` percent in `width` cells.
export const meter = (pct: number, width = METER_WIDTH): { filled: string; track: string } => {
  const cells = Math.round((pct / 100) * width)

  return { filled: '█'.repeat(cells), track: '░'.repeat(width - cells) }
}

// The colour of a usage value: green, then yellow from USAGE_WARN_PCT, then red from USAGE_ALERT_PCT.
export const usageColor = (pct: number): 'success' | 'warning' | 'error' =>
  pct >= USAGE_ALERT_PCT ? 'error' : pct >= USAGE_WARN_PCT ? 'warning' : 'success'
// Checks the typed text as it changes: why it should not be refined yet, or null when it should.
// A prompt needs at least three words with letters and must end with . , ? or !; a slash command is never refined.
export const refineBlocker = (text: string): string | null => {
  if (text.startsWith('/')) return 'Skipped'
  const words = text.split(/\s+/).filter(word => /\p{L}/u.test(word))

  if (words.length < 3) return 'Keep typing'

  return null
}

// Whether typed text should be refined: it is not the text the refiner just wrote, and it passes the check.
export const isRefinable = (text: string, lastWritten: string): boolean =>
  text !== lastWritten && refineBlocker(text) === null

// The text a user message is drawn with: its refined text when the refiner wrote one for it.
// Display only; the stored message keeps what was sent.
export const displayedUserText = (text: string, refinedFor: Map<string, string>): string =>
  refinedFor.get(text.trim()) ?? text

const rowColor = (row: ProjectRow): 'error' | 'success' | 'claude' | 'subtle' =>
  row.change === 'deleted'
    ? 'error'
    : row.change === 'edited'
      ? 'success'
      : row.kind === 'folder'
        ? 'claude'
        : 'subtle'

// Model calls made for refining, keyed by the trimmed text: one text never starts two.
const inflight = new Map<string, Promise<string | null>>()

// Refines a text once: `ask` makes the model call, and a repeat of the same text reuses it.
// Returns the refined text, or null when there is no usable answer or the call fails.
export const refineOnce = (
  text: string,
  ask: () => Promise<ModelCompleteResult>,
): Promise<string | null> => {
  const key = text.trim()
  const known = inflight.get(key)
  if (known !== undefined) return known

  if (inflight.size >= 20) {
    const oldest = inflight.keys().next().value
    if (oldest !== undefined) inflight.delete(oldest)
  }
  const call = (async (): Promise<string | null> => {
    try {
      const r = await ask()
      if (!r.isAnswered) return null
      const refined = cleanRefinement(r.text)

      return isUsableRefinement(refined) ? refined : null
    } catch {
      return null
    }
  })()
  inflight.set(key, call)

  return call
}
// Whether typed text is worth refining before it is sent: not a slash command, and at least
// three words with letters. Ending punctuation is not required here.
export const worthRefining = (text: string): boolean => {
  if (text.startsWith('/')) return false

  return text.split(/\s+/).filter(word => /\p{L}/u.test(word)).length >= 3
}
// The parent folder of a relative path; '' is the project root.
const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/')

  return slash === -1 ? '' : path.slice(0, slash)
}

// One entry of the project tree: its relative path, name, kind and depth.
export type SnapshotEntry = { path: string; name: string; isDir: boolean; depth: number }

// The most entries a snapshot keeps.
const MAX_SNAPSHOT_ENTRIES = 3000

// Reads the project tree to MAX_PROJECT_DEPTH levels. The pane draws from this copy, and it
// is read again only when files change or Refresh is pressed.
const buildSnapshot = async (
  list: (path?: string) => Promise<{ name: string; kind: 'file' | 'dir' | 'other' }[]>,
): Promise<SnapshotEntry[]> => {
  const out: SnapshotEntry[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let listed: { name: string; kind: 'file' | 'dir' | 'other' }[]
    try {
      listed = await list(dir === '' ? undefined : dir)
    } catch {
      return
    }
    const entries = listed
      .filter(entry => !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))

    for (const entry of entries) {
      if (out.length >= MAX_SNAPSHOT_ENTRIES) return
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      const isDir = entry.kind === 'dir'
      out.push({ path, name: entry.name, isDir, depth })
      if (isDir && depth < MAX_PROJECT_DEPTH) await walk(path, depth + 1)
    }
  }
  await walk('', 1)

  return out
}

// The colour of the refiner's status pill.
const statusColor = (status: string): 'success' | 'warning' | 'error' | 'subtle' =>
  status === 'Suggestion ready'
    ? 'success'
    : status === 'Waiting' || status === 'Refining'
      ? 'warning'
      : status === 'No answer'
        ? 'error'
        : 'subtle'
export const register: Register = on => {
  // The draft last sent to the model; the same text is not refined twice in a row.
  let lastRefinedDraft = ''  // Typed text -> the refined text written for it, most recent last; drawn in the transcript.
  const refinedFor = new Map<string, string>()
  // Counts changes to the prompt box; a refinement goes ahead only if no change came after it.
  let changeCount = 0
  // The session's working directory as the engine gave it, and normalised (forward slashes).
  let cwdAsGiven = ''
  let cwd = ''

  // Records a typed text and the refined text written for it, keeping the newest 50.
  const remember = (typed: string, refined: string) => {
    if (refinedFor.size >= 50) {
      const oldest = refinedFor.keys().next().value
      if (oldest !== undefined) refinedFor.delete(oldest)
    }
    refinedFor.set(typed, refined)
  }
  // A path relative to the working directory, forward slashes (absolute if outside it).
  const relPath = (path: string): string => {
    const normal = path.replace(/\\/g, '/')
    const prefix = `${cwd}/`

    return cwd !== '' && normal.toLowerCase().startsWith(prefix.toLowerCase())
      ? normal.slice(prefix.length)
      : normal
  }

  // A tree row's path relative to the project, in the separator style the project uses.
  const displayPath = (rel: string): string => {
    const sep = cwdAsGiven.includes('\\') ? '\\' : '/'

    return rel.split('/').join(sep)
  }

  on('session.start', async ($, e, next) => {
    cwdAsGiven = e.cwd
    cwd = e.cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    await $.command.register({
      name: 'session-hub',
      description: 'Open the session hub pane (usage, file tree, prompt refiner)',
    })
    // The refiner starts on in every session; a saved OFF from an earlier session does not carry over.
    await update($, isRefining, () => true)
    void $.ui.open({ id: PANE, title: 'Session hub' })
    // Redraws the pane every few seconds so usage and the file tree stay current.
    $.clock.every(4000, () => {
      void update($, tick, n => n + 1)
      // A first read that came back empty (the project was not ready yet) is read again.
      void (async () => {
        const current = await read($, treeSnapshot)
        if (current === '' || current === '[]') {
          const snapshot = await buildSnapshot(path => $.fs.list(path))
          await update($, treeSnapshot, () => JSON.stringify(snapshot))
        }
      })()
    })
    const started = await buildSnapshot(path => $.fs.list(path))
    await update($, treeSnapshot, () => JSON.stringify(started))

    return next(e)
  })

  on('command.run', { command: 'session-hub' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Session hub' })

    return { text: 'Session hub pane opened.' }
  })

  // The refiner runs beside the prompt box. As the person types, a pause of REFINE_PAUSE_MS
  // starts one refinement in the background, shown in the Session hub. The prompt box is never
  // written to here; the person picks Use or Dismiss.
  on('prompt.edit', async ($, e, next) => {
    const draft = (e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)).trim()
    changeCount += 1
    const mine = changeCount
    const note = (status: string) => update($, refineStatus, () => status)

    await update($, currentDraft, () => draft)
    const shown = await read($, suggestion)
    if (shown !== null && shown.for !== draft) {
      await update($, suggestion, () => null)
    }

    if (!(await read($, isRefining))) {
      await note('Off')

      return next(e)
    }
    const blocker = refineBlocker(draft)
    if (blocker !== null || draft === lastRefinedDraft) {
      await note(blocker ?? 'Idle')

      return next(e)
    }

    void (async () => {
      await note('Waiting')
      await $.clock.sleep(REFINE_PAUSE_MS)
      if (mine !== changeCount) return

      lastRefinedDraft = draft
      await note('Refining')
      const refined = await refineOnce(draft, () =>
        $.model.complete({
          model: 'haiku',
          prompt: refinementRequest(draft),
          system: REFINE_RULES,
          maxTokens: 800,
          effort: 'low',
        }),
      )
      if (mine !== changeCount) return
      if (refined === null) {
        await note('No answer')

        return
      }

      remember(draft, refined)
      await update($, suggestion, () => ({ for: draft, text: refined }))
      await note('Suggestion ready')
    })()

    return next(e)
  })

  // Enter sends exactly what is in the box, at once. The suggestion and the draft are cleared.
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, promptAt, () => now)
    changeCount += 1
    await update($, suggestion, () => null)
    await update($, currentDraft, () => '')
    await update($, refineStatus, () => 'Idle')

    return next(e)
  })

  // Use copies the suggested text into the prompt box, if the draft still matches it.
  on('ui.press', { plugin: 'session-hub', element: 'use' }, async ($, e, next) => {
    const shown = await read($, suggestion)
    if (shown === null) return next(e)

    const current = await read($, currentDraft)
    if (shown.for !== current) {
      $.ui.toast('Text changed, suggestion expired')
      await update($, suggestion, () => null)

      return next(e)
    }

    await $.prompt.fill({ text: shown.text })
    await update($, currentDraft, () => shown.text)
    await update($, suggestion, () => null)

    return next(e)
  })

  // Dismiss hides the suggestion.
  on('ui.press', { plugin: 'session-hub', element: 'dismiss' }, async ($, e, next) => {
    await update($, suggestion, () => null)

    return next(e)
  })
  // Notes each file a tool call edited or deleted, once the call has run.
  on('tool.call', async ($, e, next) => {
    const input = e as {
      file_path?: string
      notebook_path?: string
      command?: string
    }

    const result = await next(e)

    const note = async (path: string, kind: ChangedFile['kind']) => {
      const when = await $.clock.now()
      await update($, files, list =>
        [{ path, kind, at: when }, ...list.filter(f => f.path !== path)].slice(0, MAX_FILES),
      )
    }

    if (EDIT_TOOLS.has(e.tool)) {
      const path = input.file_path ?? input.notebook_path
      if (path) await note(path, 'edited')
    }
    if ((e.tool === 'Bash' || e.tool === 'PowerShell') && input.command) {
      for (const path of deletedPaths(input.command)) await note(path, 'deleted')
    }

    const touched =
      (EDIT_TOOLS.has(e.tool) && (input.file_path ?? input.notebook_path) !== undefined) ||
      ((e.tool === 'Bash' || e.tool === 'PowerShell') && deletedPaths(input.command ?? '').length > 0)
    if (touched) {
      const snapshot = await buildSnapshot(path => $.fs.list(path))
      await update($, treeSnapshot, () => JSON.stringify(snapshot))
    }

    return result
  })

  // Refresh reads the project tree again, for changes a tool call did not report.
  on('ui.press', { plugin: 'session-hub', element: 'refresh' }, async ($, e, next) => {
    const snapshot = await buildSnapshot(path => $.fs.list(path))
    await update($, treeSnapshot, () => JSON.stringify(snapshot))

    return next(e)
  })
  // Copies the selected path (relative to the project) when Copy path is pressed.
  on('ui.press', { plugin: 'session-hub', element: 'copy' }, async ($, e, next) => {
    const chosen = await read($, selected)
    if (chosen !== '') {
      // The surface the press came from is where the text goes.
      const result = await $.ui.copy({ text: displayPath(chosen), surface: e.surface })
      $.ui.toast(result.isCopied ? 'Path copied' : 'Could not copy the path')
    }

    return next(e)
  })

  // Draws a user message with its refined text where the refiner wrote one for what was typed.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const shown = displayedUserText(e.props.text, refinedFor)
    if (shown === e.props.text) return next(e)

    return next({ ...e, props: { ...e.props, text: shown } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    await read($, tick)

    const refining = await read($, isRefining)
    const status = await read($, refineStatus)
    const shownSuggestion = await read($, suggestion)
    const draftNow = await read($, currentDraft)
    const changed = await read($, files)
    const since = await read($, promptAt)
    const chosen = await read($, selected)
    const isAllCollapsed = await read($, collapsedAll)
    const closed = new Set(await read($, collapsed))
    const opened = new Set(await read($, expanded))
    const filterText = await read($, treeFilter)
    const isSearchOpen = await read($, searchOpen)
    const scrollAt = await read($, treeOffset)
    const filter = filterText.trim().toLowerCase()
    const snapshotText = await read($, treeSnapshot)
    const usage = await $.session.usage()
    const pct = usage.context.percent
    const usd = usage.cost?.usd
    const limits = usage.rateLimits

    // The last prompt's changes, keyed by relative path.
    const lastPrompt = changed.filter(f => f.at >= since)
    const lastByPath = new Map(lastPrompt.map(f => [relPath(f.path), f.kind] as const))

    // Files the last prompt deleted are gone from disk, so they are added from the change record.
    const snapshot: SnapshotEntry[] = snapshotText === '' ? [] : JSON.parse(snapshotText)
    const deleted: SnapshotEntry[] = []
    for (const [path, kind] of lastByPath) {
      if (kind === 'deleted' && !snapshot.some(entry => entry.path === path)) {
        deleted.push({ path, name: path.slice(path.lastIndexOf('/') + 1), isDir: false, depth: path.split('/').length })
      }
    }
    const entries = [...snapshot, ...deleted]
    const folderCount = snapshot.filter(entry => entry.isDir).length
    const fileCount = snapshot.length - folderCount

    const children = new Map<string, SnapshotEntry[]>()
    for (const entry of entries) {
      const parent = parentOf(entry.path)
      children.set(parent, [...(children.get(parent) ?? []), entry])
    }

    // A folder is open when it is not closed: all are open by default, and under
    // "Collapse all" only the ones opened again are.
    const isOpen = (path: string) => (isAllCollapsed ? opened.has(path) : !closed.has(path))

    const placed = new Set<string>()
    const project: ProjectRow[] = []

    if (filter !== '') {
      // While searching, every match is listed by its full path.
      for (const entry of entries) {
        if (!entry.name.toLowerCase().includes(filter)) continue
        project.push({
          id: entry.path,
          label: entry.path,
          name: entry.path,
          prefix: '',
          kind: entry.isDir ? 'folder' : 'file',
          canExpand: false,
          open: false,
          change: entry.isDir ? null : (lastByPath.get(entry.path) ?? null),
        })
      }
    } else {
      const walk = (dir: string, depth: number, indent: string): void => {
        const siblings = [...(children.get(dir) ?? [])].sort((a, b) =>
          a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
        )
        siblings.forEach((entry, i) => {
          const isLast = i === siblings.length - 1
          const connector = isLast ? '└─ ' : '├─ '
          const childIndent = indent + (isLast ? '   ' : '│  ')

          if (entry.isDir) {
            const canExpand = depth < MAX_PROJECT_DEPTH
            const open = canExpand && isOpen(entry.path)
            project.push({
              id: entry.path,
              label: entry.name,
              name: entry.name,
              prefix: `${indent}${connector}`,
              kind: 'folder',
              canExpand,
              open,
              change: null,
            })
            if (open) walk(entry.path, depth + 1, childIndent)
          } else {
            project.push({
              id: entry.path,
              label: entry.name,
              name: entry.name,
              prefix: `${indent}${connector}`,
              kind: 'file',
              canExpand: false,
              open: false,
              change: lastByPath.get(entry.path) ?? null,
            })
            placed.add(entry.path)
          }
        })
      }
      walk('', 1, '')
    }

    // Files the last prompt changed that the tree does not show.
    const unlisted = filter === '' ? lastPrompt.filter(f => !placed.has(relPath(f.path))) : []

    // One usage meter on one row: a short name, the bar, then the percentage. A missing value
    // shows "n/a" over an empty track rather than 0%.
    const meterRow = (label: string, raw: number | undefined, key: string, orange = false) => {
      const value = clampPct(raw)
      const tone = value === undefined ? 'subtle' : orange ? 'warning' : usageColor(value)
      const bar = meter(value ?? 0)

      return (
        <Box key={key} gap={1}>
          <Box width={4}>{label !== '' && <Text>{label}</Text>}</Box>
          <Text>
            <Text color={tone}>{bar.filled}</Text>
            <Text dimColor>{bar.track}</Text>
          </Text>
          <Text color={tone} bold>
            {value === undefined ? 'n/a' : `${Math.round(value)}%`}
          </Text>
        </Box>
      )
    }
    // The explorer renders from its scroll offset; its section clips what does not fit.
    const listRows = 200
    const offset = Math.min(Math.max(0, scrollAt), Math.max(0, project.length - 1))
    const visible = project.slice(offset, offset + listRows)
    return (
      <Box flexDirection="column" paddingX={1} height="100%">
        <Box flexDirection="column" height="45%" overflow="hidden" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Box justifyContent="space-between" gap={1}>
            <Text bold>Project</Text>
            <Box gap={1}>
              <Button key="search-toggle" plain label="⌕" onPress={() => update($, searchOpen, open => !open)} />
              <Button key="refresh" plain label="↻" onPress={() => undefined} />
              {/* Collapse all leaves the first level of folders showing; Expand all opens every folder. */}
              <Button
                key="tree"
                plain
                label={isAllCollapsed ? '▸' : '▾'}
                onPress={async () => {
                  if (isAllCollapsed) {
                    await update($, collapsed, () => [])
                    await update($, expanded, () => [])
                    await update($, collapsedAll, () => false)
                  } else {
                    await update($, expanded, () => [])
                    await update($, collapsedAll, () => true)
                  }
                }}
              />
            </Box>
          </Box>

          <Text dimColor>{snapshot.length === 0 ? 'Nothing read yet' : `${folderCount} folders · ${fileCount} files`}</Text>
          {(isSearchOpen || filterText !== '') && (<Input
            key="search"
            label="Search"
            placeholder="Filter by name"
            value={filterText}
            onInput={value => {
              update($, treeFilter, () => value)
              update($, treeOffset, () => 0)
            }}
            onSubmit={() => undefined}
          />)}

          <Box flexDirection="column">
            {snapshotText === '' && <Text dimColor>Loading the project…</Text>}
            {snapshotText !== '' && project.length === 0 && (
              <Text dimColor>
                {filter !== '' ? `No matches for "${filterText.trim()}".` : 'This folder is empty.'}
              </Text>
            )}
            {visible.map(row =>
              row.kind === 'folder' ? (
                <Box key={row.id}>
                  <Text color="subtle">{row.prefix}</Text>
                  {row.canExpand && (
                    <Button
                      key={`${row.id}:toggle`}
                      plain
                      label={row.open ? '▾ ' : '▸ '}
                      onPress={() =>
                        isAllCollapsed
                          ? update($, expanded, toggleIn(row.id))
                          : update($, collapsed, toggleIn(row.id))
                      }
                    />
                  )}
                  {/* Pressing the name selects the folder, so its path can be copied. */}
                  <Button key={row.id} plain onPress={() => update($, selected, () => row.id)}>
                    <Text color={rowColor(row)} bold={row.id === chosen}>
                      {row.name}/
                    </Text>
                  </Button> {row.id === chosen && <Button key="copy" plain label="⎘" onPress={() => undefined} />}
                </Box>
              ) : (
                <Box key={row.id}>
                  <Text color="subtle">{row.prefix}</Text>
                  <Button key={row.id} plain onPress={() => update($, selected, () => row.id)}>
                    <Text color={rowColor(row)} bold={row.id === chosen}>
                      {row.name}
                      {row.change === 'deleted' ? '  (deleted)' : ''}
                    </Text>
                  </Button> {row.id === chosen && <Button key="copy" plain label="⎘" onPress={() => undefined} />}
                </Box>
              ),
            )}
            {unlisted.length > 0 && (
              <Box flexDirection="column">
                <Text bold>Changed in last prompt, not in tree</Text>
                {unlisted.map(f => (
                  <Text key={f.path} color={f.kind === 'deleted' ? 'error' : 'success'}>
                    {clip(f.path, 60)}
                    {f.kind === 'deleted' ? '  (deleted)' : ''}
                  </Text>
                ))}
              </Box>
            )}
            {changed.length === 0 && <Text dimColor>No edits yet in this session.</Text>}
          </Box>
        </Box>

        <Box flexDirection="column" overflow="hidden" marginTop={1} borderStyle="round" borderColor="subtle" paddingX={1}>
          <Box justifyContent="space-between" gap={1}>
            <Text bold color="claude">Usage</Text>
          </Box>
          {meterRow('ctx', pct, 'context', true)}
          {limits.length === 0 && <Text dimColor>Limits appear after your first reply.</Text>}
          {limits.map(l => meterRow(shortLimitName(l.kind), l.percentUsed, l.kind))}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between" gap={1}>
            <Text bold>Prompt Refiner</Text>
            {/* The coloured dot sits inside the switch: green when on, red when off. */}
            <Button
              key="refine"
              variant={refining ? 'primary' : 'secondary'}
              onPress={() => update($, isRefining, isOn => !isOn)}
            >
              <Text color={refining ? 'success' : 'error'} bold>
                ●
              </Text>
              <Text bold>{refining ? ' ON' : ' OFF'}</Text>
            </Button>
            </Box>

          <Box paddingX={1}>
            <Text color={statusColor(status)} size="caption">{status}</Text>
          </Box>
          {shownSuggestion !== null && shownSuggestion.for === draftNow && (
            <Box flexDirection="column" borderStyle="round" borderColor="success" paddingX={1} paddingY={1} gap={1} marginTop={1}>
              <Text>{shownSuggestion.text}</Text>
              <Box gap={1}>
                <Button key="use" variant="primary" label="Use" onPress={() => undefined} />
                <Button key="dismiss" label="Dismiss" onPress={() => undefined} />
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}









































