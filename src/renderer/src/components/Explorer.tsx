import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown, ChevronRight, Copy, ExternalLink, File, FilePlus2, Folder, FolderOpen, FolderPlus,
  Pencil, RefreshCw, Search, Trash2
} from 'lucide-react'
import type { FileNode } from '../../../shared/contracts'

interface ExplorerProps {
  root: string
  nodes: FileNode[]
  activePath?: string
  onOpen(path: string): void
  onRefresh(): void
  onCreate(parent: string, kind: 'file' | 'directory'): void
  onRename(node: FileNode): void
  onMove(source: string, destinationDirectory: string): void
  onDuplicate(node: FileNode): void
  onTrash(node: FileNode): void
  onReveal(node: FileNode): void
  onCopyPath(node: FileNode): void
  onOpenExternal(node: FileNode): void
  onOpenWith(node: FileNode): void
}

interface ContextMenuState { node: FileNode; x: number; y: number }

interface TreeRowProps {
  node: FileNode
  depth: number
  activePath?: string
  expanded: Set<string>
  setExpanded(next: Set<string>): void
  onOpen(path: string): void
  onContext(event: React.MouseEvent, node: FileNode): void
  onMove(source: string, destinationDirectory: string): void
}

function TreeRow({ node, depth, activePath, expanded, setExpanded, ...actions }: TreeRowProps) {
  const isDirectory = node.kind === 'directory'
  const isOpen = expanded.has(node.path)
  const toggle = (): void => {
    if (!isDirectory) return actions.onOpen(node.path)
    const next = new Set(expanded)
    if (isOpen) next.delete(node.path)
    else next.add(node.path)
    setExpanded(next)
  }
  return <>
    <button
      type="button"
      className={`tree-row ${activePath === node.path ? 'is-active' : ''}`}
      style={{ paddingLeft: 8 + depth * 13 }}
      onClick={toggle}
      onContextMenu={(event) => actions.onContext(event, node)}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('application/x-omnicode-path', node.path)}
      onDragOver={(event) => { if (isDirectory) event.preventDefault() }}
      onDrop={(event) => {
        if (!isDirectory) return
        event.preventDefault()
        const source = event.dataTransfer.getData('application/x-omnicode-path')
        if (source && source !== node.path) actions.onMove(source, node.path)
      }}
      aria-expanded={isDirectory ? isOpen : undefined}
    >
      <span className="tree-chevron">{isDirectory ? (isOpen ? <ChevronDown /> : <ChevronRight />) : null}</span>
      {isDirectory ? (isOpen ? <FolderOpen className="folder-icon" /> : <Folder className="folder-icon" />) : <File className="file-icon" />}
      <span className="tree-label">{node.name}</span>
    </button>
    {isDirectory && isOpen && node.children?.map((child) => <TreeRow
      key={child.path} node={child} depth={depth + 1} activePath={activePath} expanded={expanded}
      setExpanded={setExpanded} {...actions}
    />)}
  </>
}

export function Explorer(props: ExplorerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setContextMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [])
  const showContext = (event: React.MouseEvent, node: FileNode): void => {
    event.preventDefault()
    setContextMenu({ node, x: Math.min(event.clientX, innerWidth - 190), y: Math.min(event.clientY, innerHeight - 250) })
  }
  return <div className="sidebar-view explorer-view">
    <div className="sidebar-title"><span>Explorer</span><div className="toolbar compact">
      <button title="New file" aria-label="New file" onClick={() => props.onCreate(props.root, 'file')}><FilePlus2 /></button>
      <button title="New folder" aria-label="New folder" onClick={() => props.onCreate(props.root, 'directory')}><FolderPlus /></button>
      <button title="Refresh" aria-label="Refresh explorer" onClick={props.onRefresh}><RefreshCw /></button>
    </div></div>
    <div className="workspace-heading" title={props.root}>{props.root.split('/').pop()?.toUpperCase()}</div>
    <div className="tree" role="tree">
      {props.nodes.map((node) => <TreeRow key={node.path} node={node} depth={0} activePath={props.activePath}
        expanded={expanded} setExpanded={setExpanded} onOpen={props.onOpen} onContext={showContext} onMove={props.onMove} />)}
      {!props.nodes.length && <div className="empty-compact">This folder is empty.</div>}
    </div>
    {contextMenu && <div ref={menuRef} className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu">
      {contextMenu.node.kind === 'file' && <button onClick={() => { props.onOpen(contextMenu.node.path); setContextMenu(null) }}><File /> Open</button>}
      {contextMenu.node.kind === 'directory' && <>
        <button onClick={() => { props.onCreate(contextMenu.node.path, 'file'); setContextMenu(null) }}><FilePlus2 /> New File</button>
        <button onClick={() => { props.onCreate(contextMenu.node.path, 'directory'); setContextMenu(null) }}><FolderPlus /> New Folder</button>
      </>}
      <div className="menu-separator" />
      <button onClick={() => { props.onRename(contextMenu.node); setContextMenu(null) }}><Pencil /> Rename</button>
      <button onClick={() => { props.onDuplicate(contextMenu.node); setContextMenu(null) }}><Copy /> Duplicate</button>
      <button onClick={() => { props.onCopyPath(contextMenu.node); setContextMenu(null) }}><Copy /> Copy Path</button>
      <button onClick={() => { props.onReveal(contextMenu.node); setContextMenu(null) }}><Search /> Reveal in Finder</button>
      <button onClick={() => { props.onOpenExternal(contextMenu.node); setContextMenu(null) }}><ExternalLink /> Open in Default App</button>
      <button onClick={() => { props.onOpenWith(contextMenu.node); setContextMenu(null) }}><ExternalLink /> Open With…</button>
      <div className="menu-separator" />
      <button className="danger" onClick={() => { props.onTrash(contextMenu.node); setContextMenu(null) }}><Trash2 /> Move to Trash…</button>
    </div>}
  </div>
}
