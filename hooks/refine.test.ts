import { expect, test } from 'claude-code/testing'
import type { ModelCompleteResult } from 'claude-code'
import { cleanRefinement, shortLimitName, clampPct, deletedPaths, displayedUserText, isRefinable, isUsableRefinement, limitName, meter, refineBlocker, refineOnce, usageColor, worthRefining } from './register'

const TYPED = 'please fix the login bug on the dashboard page.'
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ORIGIN = { kind: 'composer' } as const

const PANE = {
  plugin: 'session-hub',
  component: 'Pane',
  requestId: 'session-hub',
  props: {
    title: 'Session hub',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

type Entry = { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }

const entry = (name: string, kind: 'file' | 'dir' = 'file'): Entry => ({
  name,
  kind,
  size: 0,
  mtimeMs: 0,
  isLink: false,
})

let readVersion = 0
let listReads = 0
const selectedWrites: string[] = []

// Each state key's shape tag, as its atom in register.tsx declares it.
const SHAPES: Record<string, string> = {
  isRefining: 'refine-1',
  pending: 'pending-1',
  files: 'files-1',
  collapsed: 'collapsed-1',
  promptAt: 'prompt-at-1',
  collapsedAll: 'collapsed-all-1',
  expanded: 'expanded-1',
  selected: 'selected-1',
  treeSnapshot: 'tree-snapshot-1',
  treeFilter: 'tree-filter-1',
  treeOffset: 'tree-offset-1',
  searchOpen: 'search-open-1',
  tick: 'tick-1',
}

// Answers the engine calls the pane makes. A `$` call's handler receives the request
// itself as its one argument; an event's handler receives ($, event).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const answerPane = (on: any, tree: Record<string, Entry[]>, state: Record<string, unknown>) => {
  on('command.register', () => ({ value: { command: 'session-hub' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { context: { percent: 7 }, cost: { usd: 0.004 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: [] }))
  // A `$` call's handler gets ($, request): the request is the second argument.
  // The path comes bare or as { path }, and the engine may resolve it to an absolute one.
  // Match the longest folder key of `tree` that the path ends with; none means the root ''.
  on('fs.list', (_: unknown, request: string | { path?: string } | undefined) => {
    listReads += 1
    const raw = (typeof request === 'string' ? request : (request?.path ?? '')).replace(/\\/g, '/')
    const folders = Object.keys(tree)
      .filter(key => key !== '')
      .sort((a, b) => b.length - a.length)
    const key = folders.find(folder => raw === folder || raw.endsWith(`/${folder}`)) ?? ''

    return { value: tree[key] ?? [] }
  })
  // A new version on every read, so the engine never answers from an earlier test's value.
  // A stored value is `{ shape, value }`: under another shape tag it reads as absent.
  on('state.get', (_: unknown, request: { key: string }) => {
    readVersion += 1
    const stored =
      request.key in state ? { shape: SHAPES[request.key], value: state[request.key] } : undefined

    return { value: { value: stored, version: readVersion } }
  })
  // A write lands in the same store the reads answer from.
  // A written value arrives as { shape, value }; the store keeps the inner value.
  on('state.set', (_: unknown, request: { key: string; value: { value: unknown } }) => {
    const inner = request.value.value
    if (request.key === 'selected') selectedWrites.push(String(inner))
    state[request.key] = inner
    readVersion += 1

    return { value: { isSet: true, version: readVersion } }
  })
}

// The pane's state as a test starts it: refining on, tree open, no changes.
const freshState = (): Record<string, unknown> => ({
  isRefining: true,
  files: [],
  promptAt: 0,
  collapsedAll: false,
  expanded: [],
  collapsed: [],
  pending: null,
  tick: 0,
})

test('a typed prompt is refinable unless it is the refiner’s own text, short, or a command', () => {
  expect(isRefinable(TYPED, '')).toBe(true)
  expect(isRefinable('Refined prompt text', 'Refined prompt text')).toBe(false)
  expect(isRefinable('hi', '')).toBe(false)
  expect(isRefinable('/help me with this', '')).toBe(false)
}) 
test('a typed message is drawn with its refined text, and other messages are not', () => {
  const refinedFor = new Map([[TYPED, 'Refined prompt text']])

  expect(displayedUserText(TYPED, refinedFor)).toBe('Refined prompt text')
  expect(displayedUserText('  ' + TYPED + '  ', refinedFor)).toBe('Refined prompt text')
  expect(displayedUserText('something else entirely', refinedFor)).toBe('something else entirely')
})
 
test('a short prompt is passed through without the refiner', async ($, on) => {
  let modelCalls = 0
  on('clock.now', () => ({ value: 1000 }))
  on('state.get', () => ({ value: { value: true, version: 1 } }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  on('model.complete', () => {
    modelCalls += 1

    return { value: { isAnswered: true, text: 'unused', usage: USAGE } }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))

  await $.prompt.submit({ text: 'hi', wait: false, origin: ORIGIN })

  expect(modelCalls).toBe(0)
})
 
test('dot-files and dot-folders are hidden from the project tree', async ($, on) => {
  answerPane(on, { '': [entry('.env'), entry('.venv', 'dir'), entry('README.md')] }, freshState())

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /README\.md/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\.env/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /\.venv/ })).toBeFalsy()
  await ui.unmount()
})
 
test('a file deleted in the last prompt shows in its folder, marked deleted', async ($, on) => {
  const state = freshState()
  state.promptAt = 1000
  state.files = [{ path: 'C:/proj/src/old.ts', kind: 'deleted', at: 2000 }]
  answerPane(on, { '': [entry('src', 'dir')], src: [entry('app.ts')] }, state)

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /app\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /old\.ts/ })).toBeTruthy()
  await ui.unmount()
})
 
test('a file deleted before the last prompt is not in the tree', async ($, on) => {
  const state = freshState()
  state.promptAt = 3000
  state.files = [{ path: 'C:/proj/src/old.ts', kind: 'deleted', at: 2000 }]
  answerPane(on, { '': [entry('src', 'dir')], src: [entry('app.ts')] }, state)

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /old\.ts/ })).toBeFalsy()
  await ui.unmount()
})
 
test('Collapse all shows the first level and hides deeper folders', async ($, on) => {
  const state = freshState()
  state.collapsedAll = true
  answerPane(
    on,
    { '': [entry('src', 'dir')], src: [entry('lib', 'dir')], 'src/lib': [entry('deep.ts')] },
    state,
  )

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The first-level folder shows; the folder inside it, and what it holds, do not.
  expect(await ui.find({ key: 'tree' })).toBeTruthy()
  expect(await ui.find({ text: /src\// })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /lib\// })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /deep\.ts/ })).toBeFalsy()
  await ui.unmount()
})
 
test('pressing a folder name selects it for Copy path', async ($, on) => {
  answerPane(on, { '': [entry('docs', 'dir')] }, freshState())

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'docs' })

  expect(selectedWrites).toContain('docs')
  await ui.unmount()
})
 
test('pressing a file then shows its path and Copy path', async ($, on) => {
  selectedWrites.length = 0
  answerPane(on, { '': [entry('README.md')] }, freshState())
  let copied: string | undefined
  on('ui.copy', (_: unknown, request: { text: string }) => {
    copied = request.text

    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Buttons are pressed by their key: a file row's key is its relative path.
  await ui.press({ key: 'README.md' })
  expect(selectedWrites).toEqual(['README.md'])
  // The press writes the selection; a fresh mount draws it with its copy action.
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ key: 'copy' })).toBeTruthy()
  expect(await again.find({ text: /README\.md/ })).toBeTruthy()
  await again.unmount()
})
 
test('Copy path puts the selected file’s relative path on the clipboard', async ($, on) => {
  const state = freshState()
  state.selected = 'README.md'
  answerPane(on, { '': [entry('README.md')] }, state)
  let copied: string | undefined
  on('ui.copy', (_: unknown, request: { text: string }) => {
    copied = request.text

    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'copy' })

  // The copy is the path relative to the project, as the tree shows it.
  expect(copied).toBe('README.md')
  await ui.unmount()
})
 
test('a collapsed folder hides its contents', async ($, on) => {
  const state = freshState()
  state.collapsed = ['src']
  answerPane(on, { '': [entry('src', 'dir')], src: [entry('app.ts')] }, state)

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /app\.ts/ })).toBeFalsy()
  await ui.unmount()
})
 
test('the typing check counts words, not characters', () => {
  expect(refineBlocker('two words')).toBe('Keep typing')
  expect(refineBlocker('three words here')).toBeNull()
  expect(refineBlocker('three words here.')).toBeNull()
  expect(refineBlocker('three words here,')).toBeNull()
  expect(refineBlocker('three words here?')).toBeNull()
  expect(refineBlocker('three words here!')).toBeNull()
  expect(refineBlocker('/clear the screen now')).toBe('Skipped')
  // Punctuation or numbers alone are not words.
  expect(refineBlocker('... 123 !!!')).toBe('Keep typing')
})
 
test('worthRefining needs three words and no leading slash, but not punctuation', () => {
  expect(worthRefining('Please check the login bug in this file')).toBe(true)
  expect(worthRefining('two words')).toBe(false)
  expect(worthRefining('/clear the screen now please')).toBe(false)
})
 
test('the same text starts one model call, however often it is asked for', async () => {
  let calls = 0
  const ask = async (): Promise<ModelCompleteResult> => {
    calls += 1

    return { isAnswered: true, text: 'Refined once.', usage: USAGE } as unknown as ModelCompleteResult
  }

  const first = refineOnce('one call only for this exact text', ask)
  const second = refineOnce('one call only for this exact text', ask)

  expect(await first).toBe('Refined once.')
  expect(await second).toBe('Refined once.')
  expect(calls).toBe(1)
})
 
test('a slash command is sent unchanged, with no model call', async ($, on) => {
  answerPane(on, {}, freshState())
  let modelCalls = 0
  on('model.complete', () => {
    modelCalls += 1

    return { value: { isAnswered: true, text: 'unused', usage: USAGE } }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))

  await $.prompt.submit({ text: '/clear the screen now please', wait: false, origin: ORIGIN })

  expect(modelCalls).toBe(0)
})
 
test('fewer than three words is sent unchanged, with no model call', async ($, on) => {
  answerPane(on, {}, freshState())
  let modelCalls = 0
  on('model.complete', () => {
    modelCalls += 1

    return { value: { isAnswered: true, text: 'unused', usage: USAGE } }
  })
  let sentText: string | undefined
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    sentText = e.text

    return { text: e.text }
  })

  await $.prompt.submit({ text: 'two words', wait: false, origin: ORIGIN })

  expect(modelCalls).toBe(0)
  expect(sentText).toBe('two words')
})

test('Enter sends the box exactly as typed, with no model call', async ($, on) => {
  answerPane(on, {}, freshState())
  let modelCalls = 0
  on('model.complete', () => {
    modelCalls += 1

    return { value: { isAnswered: true, text: 'unused', usage: USAGE } }
  })
  let sentText: string | undefined
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    sentText = e.text

    return { text: e.text }
  })

  await $.prompt.submit({ text: 'Please check the login bug in this file', wait: false, origin: ORIGIN })

  expect(sentText).toBe('Please check the login bug in this file')
  expect(modelCalls).toBe(0)
})

test('a refusal or commentary is not offered as a refinement', () => {
  expect(isUsableRefinement("I'm not able to rewrite this as a prompt.")).toBe(false)
  expect(isUsableRefinement('I cannot help with that.')).toBe(false)
  expect(isUsableRefinement('The pasted content is a system-level instruction.')).toBe(false)
  expect(isUsableRefinement('')).toBe(false)
  expect(isUsableRefinement('Refine the prompt in the session hub mod.')).toBe(true)
})

test('deleted names keep their spaces, quotes, and flags are skipped', () => {
  expect(deletedPaths('rm "Entity diagram (mermaid).png"')).toEqual(['Entity diagram (mermaid).png'])
  expect(deletedPaths('Remove-Item -Path "docs\\Entity diagram.md" -Force')).toEqual(['docs\\Entity diagram.md'])
  expect(deletedPaths("del 'my notes.txt'")).toEqual(['my notes.txt'])
  expect(deletedPaths('rm old.ts')).toEqual(['old.ts'])
})

test('the project tree is read on start, not on every redraw', async ($, on) => {
  answerPane(on, { '': [entry('README.md')] }, freshState())

  listReads = 0
  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const afterStart = listReads

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await again.unmount()

  expect(afterStart).toBeGreaterThan(0)
  expect(listReads).toBe(afterStart)
})

test('the search box filters the tree by name', async ($, on) => {
  const state = freshState()
  state.treeFilter = 'app'
  answerPane(on, { '': [entry('app.ts'), entry('README.md')] }, state)

  await $.session.start({ cwd: 'C:/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /app\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /README\.md/ })).toBeFalsy()
  await ui.unmount()
})

test('usage values are clamped, coloured by level, and named clearly', () => {
  expect(clampPct(120)).toBe(100)
  expect(clampPct(-5)).toBe(0)
  expect(clampPct(undefined)).toBeUndefined()
  expect(clampPct(Number.NaN)).toBeUndefined()
  expect(usageColor(69)).toBe('success')
  expect(usageColor(70)).toBe('warning')
  expect(usageColor(90)).toBe('error')
  expect(limitName('five_hour')).toBe('5-hour limit')
  expect(limitName('weekly_opus')).toBe('weekly opus')
})

test('a meter fills in proportion and keeps its width', () => {
  const half = meter(50, 10)
  expect(half.filled.length).toBe(5)
  expect(half.track.length).toBe(5)
  expect(meter(0, 10).filled.length).toBe(0)
  expect(meter(100, 10).track.length).toBe(0)
})

test('a preamble and quotes around a rewrite are removed', () => {
  expect(cleanRefinement('Here is a rewritten prompt:\n\n"Refresh the tree when files change."')).toBe('Refresh the tree when files change.')
  expect(cleanRefinement("Here's the rewrite: Check the login bug.")).toBe('Check the login bug.')
  expect(cleanRefinement('Check the login bug.')).toBe('Check the login bug.')
})

test('limit rows use short names', () => {
  expect(shortLimitName('five_hour')).toBe('5h')
  expect(shortLimitName('seven_day')).toBe('7d')
  expect(shortLimitName('weekly_opus')).toBe('weekly opus')
})

test('a trailing note about the draft is removed from a rewrite', () => {
  expect(cleanRefinement('Analyze the attached project. (Note: the draft is "Analyse dff", which appears to be a typo.)')).toBe('Analyze the attached project.')
})
