import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  CreateDiffProposalRequest,
  DiffDecisionStatus,
  DiffDecisionTarget,
  DiffHunk,
  DiffProposal,
  DiffProposalFile,
  DiffReviewLine
} from '../../shared/contracts'
import { FileSystemManager, isPathInside } from './filesystem-manager'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_PROPOSAL_BYTES = 32 * 1024 * 1024
const MAX_PROPOSAL_FILES = 200
const CONTEXT_LINES = 3
const MAX_LCS_CELLS = 2_000_000

type LineOperationKind = 'context' | 'add' | 'delete'
type HunkDecision = Exclude<DiffDecisionStatus, 'partial'>

interface LineOperation {
  kind: LineOperationKind
  text: string
}

interface InternalHunk {
  id: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffReviewLine[]
  baseStart: number
  baseDeleteCount: number
  replacementLines: string[]
  decision: HunkDecision
}

interface InternalFile {
  id: string
  path: string
  relativePath: string
  kind: DiffProposalFile['kind']
  baseContent: string | null
  proposedContent: string | null
  expectedContent: string | null
  expectedMode?: number
  hunks: InternalHunk[]
  unifiedDiff: string
}

interface InternalProposal {
  id: string
  title: string
  workspaceRoot: string
  canonicalRoot: string
  createdAt: number
  updatedAt: number
  files: InternalFile[]
}

interface DiskState {
  content: string | null
  mode?: number
}

interface TransactionEntry {
  file: InternalFile
  beforeContent: string | null
  beforeMode?: number
  afterContent: string | null
  afterMode?: number
}

interface UndoDecision {
  hunk: InternalHunk
  previous: HunkDecision
}

interface UndoTransaction {
  proposalId: string
  entries: TransactionEntry[]
  decisions: UndoDecision[]
}

interface PreparedEntry {
  transaction: TransactionEntry
  temporaryPath?: string
}

interface ProcessedEntry {
  transaction: TransactionEntry
  backupPath?: string
  installed: boolean
}

function splitText(text: string): string[] {
  if (!text) return []
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function displayLine(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2)
  if (line.endsWith('\n')) return line.slice(0, -1)
  return line
}

function countConsumed(operations: LineOperation[], kind: 'old' | 'new'): number {
  return operations.reduce((count, operation) => {
    if (kind === 'old' && operation.kind !== 'add') return count + 1
    if (kind === 'new' && operation.kind !== 'delete') return count + 1
    return count
  }, 0)
}

function coarseLineDiff(original: string[], proposed: string[]): LineOperation[] {
  let prefix = 0
  while (prefix < original.length && prefix < proposed.length && original[prefix] === proposed[prefix]) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < original.length - prefix &&
    suffix < proposed.length - prefix &&
    original[original.length - suffix - 1] === proposed[proposed.length - suffix - 1]
  ) {
    suffix += 1
  }

  return [
    ...original.slice(0, prefix).map((text) => ({ kind: 'context' as const, text })),
    ...original.slice(prefix, original.length - suffix).map((text) => ({ kind: 'delete' as const, text })),
    ...proposed.slice(prefix, proposed.length - suffix).map((text) => ({ kind: 'add' as const, text })),
    ...original.slice(original.length - suffix).map((text) => ({ kind: 'context' as const, text }))
  ]
}

function lineDiff(original: string[], proposed: string[]): LineOperation[] {
  if (original.length * proposed.length > MAX_LCS_CELLS) {
    return coarseLineDiff(original, proposed)
  }

  const rows = Array.from(
    { length: original.length + 1 },
    () => new Uint32Array(proposed.length + 1)
  )

  for (let oldIndex = original.length - 1; oldIndex >= 0; oldIndex -= 1) {
    const row = rows[oldIndex]
    const nextRow = rows[oldIndex + 1]
    if (!row || !nextRow) continue
    for (let newIndex = proposed.length - 1; newIndex >= 0; newIndex -= 1) {
      row[newIndex] = original[oldIndex] === proposed[newIndex]
        ? (nextRow[newIndex + 1] ?? 0) + 1
        : Math.max(nextRow[newIndex] ?? 0, row[newIndex + 1] ?? 0)
    }
  }

  const operations: LineOperation[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < original.length || newIndex < proposed.length) {
    if (
      oldIndex < original.length &&
      newIndex < proposed.length &&
      original[oldIndex] === proposed[newIndex]
    ) {
      operations.push({ kind: 'context', text: original[oldIndex] ?? '' })
      oldIndex += 1
      newIndex += 1
      continue
    }

    const removeScore = rows[oldIndex + 1]?.[newIndex] ?? 0
    const addScore = rows[oldIndex]?.[newIndex + 1] ?? 0
    if (newIndex < proposed.length && (oldIndex >= original.length || addScore > removeScore)) {
      operations.push({ kind: 'add', text: proposed[newIndex] ?? '' })
      newIndex += 1
    } else if (oldIndex < original.length) {
      operations.push({ kind: 'delete', text: original[oldIndex] ?? '' })
      oldIndex += 1
    }
  }
  return operations
}

function buildHunks(originalContent: string, proposedContent: string): InternalHunk[] {
  const original = splitText(originalContent)
  const proposed = splitText(proposedContent)
  const operations = lineDiff(original, proposed)
  const changed = operations
    .map((operation, index) => operation.kind === 'context' ? -1 : index)
    .filter((index) => index >= 0)

  if (changed.length === 0) return []

  const groups: Array<{ first: number; last: number }> = []
  for (const operationIndex of changed) {
    const previous = groups.at(-1)
    if (previous && operationIndex - previous.last - 1 <= CONTEXT_LINES * 2) {
      previous.last = operationIndex
    } else {
      groups.push({ first: operationIndex, last: operationIndex })
    }
  }

  return groups.map((group, index): InternalHunk => {
    const beforeChange = operations.slice(0, group.first)
    const changedOperations = operations.slice(group.first, group.last + 1)
    const displayStart = Math.max(0, group.first - CONTEXT_LINES)
    const displayEnd = Math.min(operations.length, group.last + CONTEXT_LINES + 1)
    const displayOperations = operations.slice(displayStart, displayEnd)
    const beforeDisplay = operations.slice(0, displayStart)
    const oldBeforeDisplay = countConsumed(beforeDisplay, 'old')
    const newBeforeDisplay = countConsumed(beforeDisplay, 'new')
    const oldLines = countConsumed(displayOperations, 'old')
    const newLines = countConsumed(displayOperations, 'new')
    const oldStart = oldLines === 0 ? oldBeforeDisplay : oldBeforeDisplay + 1
    const newStart = newLines === 0 ? newBeforeDisplay : newBeforeDisplay + 1
    const reviewLines: DiffReviewLine[] = []
    let oldLine = oldBeforeDisplay + 1
    let newLine = newBeforeDisplay + 1

    for (const operation of displayOperations) {
      if (operation.kind === 'context') {
        reviewLines.push({
          kind: 'context',
          content: displayLine(operation.text),
          oldLine,
          newLine
        })
        oldLine += 1
        newLine += 1
      } else if (operation.kind === 'delete') {
        reviewLines.push({ kind: 'delete', content: displayLine(operation.text), oldLine })
        oldLine += 1
      } else {
        reviewLines.push({ kind: 'add', content: displayLine(operation.text), newLine })
        newLine += 1
      }
    }

    const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`
    return {
      id: `hunk-${index + 1}`,
      header,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: reviewLines,
      baseStart: countConsumed(beforeChange, 'old'),
      baseDeleteCount: countConsumed(changedOperations, 'old'),
      replacementLines: changedOperations
        .filter((operation) => operation.kind !== 'delete')
        .map((operation) => operation.text),
      decision: 'pending'
    }
  })
}

function emptyFileHunk(): InternalHunk {
  return {
    id: 'hunk-1',
    header: '@@ -0,0 +0,0 @@',
    oldStart: 0,
    oldLines: 0,
    newStart: 0,
    newLines: 0,
    lines: [],
    baseStart: 0,
    baseDeleteCount: 0,
    replacementLines: [],
    decision: 'pending'
  }
}

function fileStatus(file: InternalFile): DiffDecisionStatus {
  const decisions = file.hunks.map((hunk) => hunk.decision)
  if (decisions.every((decision) => decision === 'accepted')) return 'accepted'
  if (decisions.every((decision) => decision === 'rejected')) return 'rejected'
  if (decisions.every((decision) => decision === 'pending')) return 'pending'
  return 'partial'
}

function proposalStatus(proposal: InternalProposal): DiffDecisionStatus {
  const statuses = proposal.files.map(fileStatus)
  if (statuses.every((status) => status === 'accepted')) return 'accepted'
  if (statuses.every((status) => status === 'rejected')) return 'rejected'
  if (statuses.every((status) => status === 'pending')) return 'pending'
  return 'partial'
}

function composeAcceptedContent(file: InternalFile, additionallyAccepted = new Set<string>()): string | null {
  const isAccepted = (hunk: InternalHunk): boolean => (
    hunk.decision === 'accepted' || additionallyAccepted.has(hunk.id)
  )

  if (file.kind === 'create') return file.hunks.some(isAccepted) ? file.proposedContent ?? '' : null
  if (file.kind === 'delete') return file.hunks.some(isAccepted) ? null : file.baseContent ?? ''

  const lines = splitText(file.baseContent ?? '')
  const accepted = file.hunks
    .filter(isAccepted)
    .sort((left, right) => right.baseStart - left.baseStart)
  for (const hunk of accepted) {
    lines.splice(hunk.baseStart, hunk.baseDeleteCount, ...hunk.replacementLines)
  }
  return lines.join('')
}

function makeUnifiedDiff(
  relativePath: string,
  kind: InternalFile['kind'],
  hunks: InternalHunk[]
): string {
  const originalLabel = kind === 'create' ? '/dev/null' : `a/${relativePath}`
  const proposedLabel = kind === 'delete' ? '/dev/null' : `b/${relativePath}`
  const output = [`diff --git a/${relativePath} b/${relativePath}`]
  if (kind === 'create') output.push('new file mode 100644')
  if (kind === 'delete') output.push('deleted file mode 100644')
  output.push(`--- ${originalLabel}`, `+++ ${proposedLabel}`)
  for (const hunk of hunks) {
    output.push(hunk.header)
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '
      output.push(`${prefix}${line.content}`)
    }
  }
  return `${output.join('\n')}\n`
}

function publicHunk(hunk: InternalHunk): DiffHunk {
  return {
    id: hunk.id,
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    status: hunk.decision,
    lines: hunk.lines.map((line) => ({ ...line }))
  }
}

async function readDiskState(target: string): Promise<DiskState> {
  let stats
  try {
    stats = await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: null }
    throw error
  }

  if (stats.isSymbolicLink()) {
    throw new Error('AI change review does not modify symbolic-link files. Open the real file instead.')
  }
  if (!stats.isFile()) throw new Error('AI change review supports text files only.')
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error('AI change review is limited to 8 MB per text file.')
  }
  const buffer = await fs.readFile(target)
  if (buffer.includes(0)) throw new Error('AI change review cannot modify binary files.')
  return { content: buffer.toString('utf8'), mode: stats.mode & 0o777 }
}

function assertExpectedState(target: string, actual: DiskState, expectedContent: string | null): void {
  if (actual.content !== expectedContent) {
    throw new Error(
      `“${path.basename(target)}” changed on disk after the proposal was created. ` +
      'Review the current file and create a new proposal instead of overwriting it.'
    )
  }
}

async function nearestExistingPath(target: string): Promise<string> {
  let candidate = target
  while (true) {
    try {
      await fs.lstat(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(candidate)
      if (parent === candidate) throw new Error('No existing parent directory was found for the proposed file.')
      candidate = parent
    }
  }
}

export class DiffManager extends EventEmitter {
  private proposals = new Map<string, InternalProposal>()
  private undoTransactions = new Map<string, UndoTransaction>()
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly fileSystem: FileSystemManager) {
    super()
  }

  async propose(request: CreateDiffProposalRequest): Promise<DiffProposal> {
    if (!request.changes.length) throw new Error('The proposal does not contain any file changes.')
    if (request.changes.length > MAX_PROPOSAL_FILES) {
      throw new Error(`A single proposal is limited to ${MAX_PROPOSAL_FILES} files.`)
    }

    const { workspaceRoot, canonicalRoot } = await this.resolveWorkspace(request.workspaceRoot)
    const seen = new Set<string>()
    const files: InternalFile[] = []
    let proposalBytes = 0

    for (const change of request.changes) {
      const resolved = await this.resolveProposedPath(workspaceRoot, canonicalRoot, change.path)
      if (seen.has(resolved.path)) throw new Error(`The proposal contains duplicate changes for ${resolved.relativePath}.`)
      seen.add(resolved.path)

      const disk = await readDiskState(resolved.path)
      let baseContent: string | null
      let proposedContent: string | null
      if (change.kind === 'create') {
        if (disk.content !== null) throw new Error(`Cannot create ${resolved.relativePath} because it already exists.`)
        baseContent = null
        proposedContent = change.content
      } else if (change.kind === 'modify') {
        if (disk.content === null) throw new Error(`Cannot modify ${resolved.relativePath} because it does not exist.`)
        baseContent = disk.content
        proposedContent = change.content
        if (baseContent === proposedContent) continue
      } else {
        if (disk.content === null) throw new Error(`Cannot delete ${resolved.relativePath} because it does not exist.`)
        baseContent = disk.content
        proposedContent = null
      }

      const proposedBytes = Buffer.byteLength(proposedContent ?? '', 'utf8')
      if (proposedBytes > MAX_FILE_BYTES) {
        throw new Error(`${resolved.relativePath} exceeds the 8 MB text-change limit.`)
      }
      proposalBytes += Buffer.byteLength(baseContent ?? '', 'utf8') + proposedBytes
      if (proposalBytes > MAX_PROPOSAL_BYTES) {
        throw new Error('The proposal exceeds the 32 MB in-memory review limit.')
      }

      const hunks = buildHunks(baseContent ?? '', proposedContent ?? '')
      if (hunks.length === 0) hunks.push(emptyFileHunk())
      files.push({
        id: randomUUID(),
        path: resolved.path,
        relativePath: resolved.relativePath,
        kind: change.kind,
        baseContent,
        proposedContent,
        expectedContent: baseContent,
        expectedMode: disk.mode,
        hunks,
        unifiedDiff: makeUnifiedDiff(resolved.relativePath, change.kind, hunks)
      })
    }

    if (files.length === 0) throw new Error('The proposal does not change any file content.')
    const now = Date.now()
    const proposal: InternalProposal = {
      id: randomUUID(),
      title: request.title?.trim() || 'AI proposed changes',
      workspaceRoot,
      canonicalRoot,
      createdAt: now,
      updatedAt: now,
      files
    }
    this.proposals.set(proposal.id, proposal)
    const result = this.toPublic(proposal)
    this.emit('changed', result)
    return result
  }

  get(proposalId: string): DiffProposal {
    return this.toPublic(this.requireProposal(proposalId))
  }

  accept(proposalId: string, target: DiffDecisionTarget): Promise<DiffProposal> {
    return this.mutate(async () => {
      const proposal = this.requireProposal(proposalId)
      const selected = this.selectHunks(proposal, target)
        .filter(({ hunk }) => hunk.decision === 'pending')
      if (selected.length === 0) return this.toPublic(proposal)

      const selectedByFile = new Map<InternalFile, Set<string>>()
      for (const { file, hunk } of selected) {
        const ids = selectedByFile.get(file) ?? new Set<string>()
        ids.add(hunk.id)
        selectedByFile.set(file, ids)
      }

      const entries: TransactionEntry[] = [...selectedByFile].map(([file, hunkIds]) => ({
        file,
        beforeContent: file.expectedContent,
        beforeMode: file.expectedMode,
        afterContent: composeAcceptedContent(file, hunkIds),
        afterMode: file.expectedMode
      }))
      await this.applyTransaction(proposal, entries)

      const decisions: UndoDecision[] = selected.map(({ hunk }) => ({ hunk, previous: hunk.decision }))
      for (const { hunk } of selected) hunk.decision = 'accepted'
      for (const entry of entries) {
        entry.file.expectedContent = entry.afterContent
        entry.file.expectedMode = entry.afterContent === null
          ? undefined
          : entry.afterMode ?? entry.beforeMode ?? 0o644
        entry.afterMode = entry.file.expectedMode
      }
      proposal.updatedAt = Date.now()
      this.undoTransactions.set(proposal.id, { proposalId: proposal.id, entries, decisions })
      const result = this.toPublic(proposal)
      this.emit('changed', result)
      return result
    })
  }

  reject(proposalId: string, target: DiffDecisionTarget): Promise<DiffProposal> {
    return this.mutate(async () => {
      const proposal = this.requireProposal(proposalId)
      for (const { hunk } of this.selectHunks(proposal, target)) {
        if (hunk.decision === 'pending') hunk.decision = 'rejected'
      }
      proposal.updatedAt = Date.now()
      const result = this.toPublic(proposal)
      this.emit('changed', result)
      return result
    })
  }

  undo(proposalId: string): Promise<DiffProposal> {
    return this.mutate(async () => {
      const proposal = this.requireProposal(proposalId)
      const undo = this.undoTransactions.get(proposalId)
      if (!undo) throw new Error('There is no accepted AI change to undo for this proposal.')

      const entries = undo.entries.map((entry): TransactionEntry => ({
        file: entry.file,
        beforeContent: entry.afterContent,
        beforeMode: entry.afterMode,
        afterContent: entry.beforeContent,
        afterMode: entry.beforeMode
      }))
      await this.applyTransaction(proposal, entries)
      for (const entry of entries) {
        entry.file.expectedContent = entry.afterContent
        entry.file.expectedMode = entry.afterContent === null
          ? undefined
          : entry.afterMode ?? entry.beforeMode ?? 0o644
      }
      for (const decision of undo.decisions) decision.hunk.decision = decision.previous
      proposal.updatedAt = Date.now()
      this.undoTransactions.delete(proposalId)
      const result = this.toPublic(proposal)
      this.emit('changed', result)
      return result
    })
  }

  discard(proposalId: string): Promise<void> {
    return this.mutate(async () => {
      const proposal = this.requireProposal(proposalId)
      if (proposal.files.some((file) => file.hunks.some((hunk) => hunk.decision === 'accepted'))) {
        throw new Error('Undo accepted changes before discarding this proposal.')
      }
      this.proposals.delete(proposalId)
      this.undoTransactions.delete(proposalId)
    })
  }

  private async resolveWorkspace(requestedRoot: string): Promise<{
    workspaceRoot: string
    canonicalRoot: string
  }> {
    const activeRoot = this.fileSystem.getWorkspace()
    if (!activeRoot) throw new Error('Open a workspace before creating an AI change proposal.')
    const requestedPath = path.resolve(requestedRoot)
    const canonicalRoot = await fs.realpath(requestedPath)
    if (canonicalRoot !== await fs.realpath(activeRoot)) {
      throw new Error('AI changes are restricted to the currently open workspace.')
    }
    const workspaceRoot = canonicalRoot
    const stats = await fs.stat(workspaceRoot)
    if (!stats.isDirectory()) throw new Error('The active workspace is not a directory.')
    return { workspaceRoot, canonicalRoot }
  }

  private async resolveProposedPath(
    workspaceRoot: string,
    canonicalRoot: string,
    requestedPath: string
  ): Promise<{ path: string; relativePath: string }> {
    if (!requestedPath || requestedPath.includes('\0')) throw new Error('The proposal contains an invalid file path.')
    const target = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(workspaceRoot, requestedPath)
    if (!isPathInside(workspaceRoot, target) || target === workspaceRoot) {
      throw new Error('AI changes cannot access a path outside the current workspace.')
    }

    const existing = await nearestExistingPath(target)
    const canonicalExisting = await fs.realpath(existing)
    if (!isPathInside(canonicalRoot, canonicalExisting)) {
      throw new Error('AI changes cannot follow a symbolic link outside the current workspace.')
    }
    this.fileSystem.resolveAuthorizedPath(target)

    return {
      path: target,
      relativePath: path.relative(workspaceRoot, target).split(path.sep).join('/')
    }
  }

  private requireProposal(proposalId: string): InternalProposal {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) throw new Error('That AI change proposal is no longer available.')
    return proposal
  }

  private selectHunks(
    proposal: InternalProposal,
    target: DiffDecisionTarget
  ): Array<{ file: InternalFile; hunk: InternalHunk }> {
    if (target.scope === 'all') {
      return proposal.files.flatMap((file) => file.hunks.map((hunk) => ({ file, hunk })))
    }

    const file = proposal.files.find((candidate) => candidate.id === target.fileId)
    if (!file) throw new Error('The selected proposal file was not found.')
    if (target.scope === 'file') return file.hunks.map((hunk) => ({ file, hunk }))

    const hunk = file.hunks.find((candidate) => candidate.id === target.hunkId)
    if (!hunk) throw new Error('The selected change hunk was not found.')
    return [{ file, hunk }]
  }

  private async applyTransaction(proposal: InternalProposal, entries: TransactionEntry[]): Promise<void> {
    if (entries.length === 0) return
    const uniquePaths = new Set(entries.map((entry) => entry.file.path))
    if (uniquePaths.size !== entries.length) throw new Error('A transaction cannot modify the same file twice.')

    for (const entry of entries) {
      // Re-run both the workspace capability and canonical ancestor checks at
      // acceptance time. A directory that did not exist when the proposal was
      // created may have since been replaced with a symlink.
      await this.resolveProposedPath(
        proposal.workspaceRoot,
        proposal.canonicalRoot,
        entry.file.path
      )
      const current = await readDiskState(entry.file.path)
      assertExpectedState(entry.file.path, current, entry.beforeContent)
    }

    const prepared: PreparedEntry[] = []
    try {
      for (const entry of entries) {
        if (entry.afterContent === null) {
          prepared.push({ transaction: entry })
          continue
        }
        await fs.mkdir(path.dirname(entry.file.path), { recursive: true })
        await this.resolveProposedPath(
          proposal.workspaceRoot,
          proposal.canonicalRoot,
          entry.file.path
        )
        const temporaryPath = path.join(
          path.dirname(entry.file.path),
          `.${path.basename(entry.file.path)}.omnicode-write-${randomUUID()}`
        )
        await fs.writeFile(temporaryPath, entry.afterContent, {
          encoding: 'utf8',
          flag: 'wx',
          mode: entry.afterMode ?? entry.beforeMode ?? 0o644
        })
        prepared.push({ transaction: entry, temporaryPath })
      }
    } catch (error) {
      await Promise.all(prepared.map(async (entry) => {
        if (entry.temporaryPath) await fs.rm(entry.temporaryPath, { force: true }).catch(() => undefined)
      }))
      throw error
    }

    const processed: ProcessedEntry[] = []
    try {
      for (const item of prepared) {
        const entry = item.transaction
        const processedEntry: ProcessedEntry = { transaction: entry, installed: false }
        processed.push(processedEntry)

        if (entry.beforeContent !== null) {
          const backupPath = path.join(
            path.dirname(entry.file.path),
            `.${path.basename(entry.file.path)}.omnicode-backup-${randomUUID()}`
          )
          await fs.rename(entry.file.path, backupPath)
          processedEntry.backupPath = backupPath
          const movedState = await readDiskState(backupPath)
          assertExpectedState(entry.file.path, movedState, entry.beforeContent)
          if (item.temporaryPath) {
            await fs.rename(item.temporaryPath, entry.file.path)
            item.temporaryPath = undefined
            processedEntry.installed = true
          }
        } else if (item.temporaryPath) {
          await fs.link(item.temporaryPath, entry.file.path)
          processedEntry.installed = true
          await fs.rm(item.temporaryPath, { force: true })
          item.temporaryPath = undefined
        }
      }
    } catch (error) {
      let rollbackError: unknown
      for (const item of [...processed].reverse()) {
        try {
          if (item.installed) await fs.rm(item.transaction.file.path, { force: true })
          if (item.backupPath) await fs.rename(item.backupPath, item.transaction.file.path)
        } catch (cause) {
          rollbackError ??= cause
        }
      }
      await Promise.all(prepared.map(async (entry) => {
        if (entry.temporaryPath) await fs.rm(entry.temporaryPath, { force: true }).catch(() => undefined)
      }))
      if (rollbackError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ` +
          `Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        )
      }
      throw error
    }

    await Promise.all(processed.map(async (entry) => {
      if (entry.backupPath) await fs.rm(entry.backupPath, { force: true }).catch(() => undefined)
    }))
  }

  private toPublic(proposal: InternalProposal): DiffProposal {
    const files = proposal.files.map((file): DiffProposalFile => {
      const additions = file.hunks.reduce(
        (count, hunk) => count + hunk.lines.filter((line) => line.kind === 'add').length,
        0
      )
      const deletions = file.hunks.reduce(
        (count, hunk) => count + hunk.lines.filter((line) => line.kind === 'delete').length,
        0
      )
      return {
        id: file.id,
        path: file.path,
        relativePath: file.relativePath,
        kind: file.kind,
        status: fileStatus(file),
        additions,
        deletions,
        originalContent: file.baseContent ?? '',
        proposedContent: file.proposedContent ?? '',
        currentContent: file.expectedContent ?? '',
        reviewContent: composeAcceptedContent(
          file,
          new Set(file.hunks.filter((hunk) => hunk.decision === 'pending').map((hunk) => hunk.id))
        ) ?? '',
        unifiedDiff: file.unifiedDiff,
        hunks: file.hunks.map(publicHunk)
      }
    })
    const decisions = proposal.files.flatMap((file) => file.hunks.map((hunk) => hunk.decision))
    return {
      id: proposal.id,
      title: proposal.title,
      workspaceRoot: proposal.workspaceRoot,
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt,
      status: proposalStatus(proposal),
      pendingHunks: decisions.filter((decision) => decision === 'pending').length,
      acceptedHunks: decisions.filter((decision) => decision === 'accepted').length,
      rejectedHunks: decisions.filter((decision) => decision === 'rejected').length,
      canUndo: this.undoTransactions.has(proposal.id),
      files
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}
