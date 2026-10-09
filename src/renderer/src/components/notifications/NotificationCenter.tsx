import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  Check,
  CheckCheck,
  CircleAlert,
  Code2,
  Mail,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'

import type { NotificationSnapshot, OmniNotification } from '../../../../shared/notification-contracts'
import { OmniModeLogo } from '../omni/OmniModeLogo'
import './NotificationCenter.css'

type NotificationFilter = 'all' | 'code' | 'work' | 'errors'

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return 'now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function NotificationIcon({ notification }: { notification: OmniNotification }) {
  if (notification.severity === 'error' || notification.severity === 'warning') return <CircleAlert />
  if (notification.type === 'EMAIL_SENT') return <Mail />
  if (notification.sourceMode === 'code') return <Code2 />
  if (notification.sourceMode === 'omni') return <OmniModeLogo />
  return <Sparkles />
}

export function NotificationCenter({ onNavigate }: { onNavigate(notification: OmniNotification): void }) {
  const [snapshot, setSnapshot] = useState<NotificationSnapshot | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<NotificationFilter>('all')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    void window.omnicode.notifications.snapshot().then((value) => { if (active) { setSnapshot(value); setError('') } }).catch(() => { if (active) setError('Notifications could not be loaded. Try again.') })
    const remove = window.omnicode.notifications.onChanged((value) => { if (active) { setSnapshot(value); setError('') } })
    return () => { active = false; remove() }
  }, [])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', dismiss, true)
    return () => window.removeEventListener('mousedown', dismiss, true)
  }, [open])

  const notifications = useMemo(() => (snapshot?.notifications ?? []).filter((notification) => {
    if (filter === 'code') return notification.sourceMode === 'code'
    if (filter === 'work') return notification.sourceMode === 'work'
    if (filter === 'errors') return notification.severity === 'error' || notification.severity === 'warning'
    return true
  }), [filter, snapshot])

  const openNotification = async (notification: OmniNotification): Promise<void> => {
    if (!notification.read) {
      try { setSnapshot(await window.omnicode.notifications.markRead(notification.id)) }
      catch { setError('Could not mark that notification as read.') }
    }
    setOpen(false)
    onNavigate(notification)
  }

  return <div className="notification-center" ref={rootRef}>
    <button className={`notification-bell${open ? ' active' : ''}`} type="button" title="Notification Center" aria-label={`Notification Center, ${snapshot?.unreadCount ?? 0} unread`} aria-expanded={open} aria-controls="omnicode-notification-panel" onClick={() => setOpen((value) => !value)}>
      <Bell />
      {!!snapshot?.unreadCount && <span>{Math.min(snapshot.unreadCount, 99)}</span>}
    </button>
    {open && <section className="notification-panel" id="omnicode-notification-panel" aria-label="Notification Center">
      <header><span><strong>Notification Center</strong><small>{snapshot?.unreadCount ?? 0} unread</small></span><button type="button" title="Close Notification Center" aria-label="Close Notification Center" onClick={() => setOpen(false)}><X /></button></header>
      <div className="notification-toolbar">
        <div>{(['all', 'code', 'work', 'errors'] as const).map((value) => <button type="button" className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
        <button type="button" disabled={!snapshot?.unreadCount} aria-label="Mark all as read" onClick={() => void window.omnicode.notifications.markAllRead().then(setSnapshot).catch(() => setError('Could not mark all notifications as read.'))}><CheckCheck />Mark all read</button>
      </div>
      <div className="notification-list">
        {error && <div className="notification-error" role="alert">{error}<button type="button" onClick={() => void window.omnicode.notifications.snapshot().then((value) => { setSnapshot(value); setError('') }).catch(() => setError('Notifications could not be loaded. Try again.'))}>Retry</button></div>}
        {notifications.map((notification) => <article className={`${notification.read ? 'read' : 'unread'} severity-${notification.severity}`} key={notification.id}>
          <button className="notification-open" type="button" onClick={() => void openNotification(notification)}>
            <span className="notification-type-icon"><NotificationIcon notification={notification} /></span>
            <span><strong>{notification.title}</strong><small>{notification.description}</small><em>{notification.sourceMode === 'system' ? 'OmniCode' : `${notification.sourceMode[0].toUpperCase()}${notification.sourceMode.slice(1)} Mode`} · {relativeTime(notification.timestamp)}</em></span>
            {!notification.read && <i />}
          </button>
          <div className="notification-row-actions">
            <button type="button" title={notification.read ? 'Mark unread' : 'Mark read'} aria-label={`${notification.read ? 'Mark unread' : 'Mark read'}: ${notification.title}`} onClick={() => void window.omnicode.notifications.markRead(notification.id, !notification.read).then(setSnapshot).catch(() => setError('Could not update that notification.'))}><Check /></button>
            <button type="button" title="Clear notification" aria-label={`Clear notification: ${notification.title}`} onClick={() => void window.omnicode.notifications.remove(notification.id).then(setSnapshot).catch(() => setError('Could not clear that notification.'))}><Trash2 /></button>
          </div>
        </article>)}
        {!notifications.length && <div className="notification-empty"><Bell /><strong>No notifications here</strong><p>Completed tasks and important failures will appear automatically.</p></div>}
      </div>
      {!!snapshot?.notifications.length && <footer><button type="button" aria-label="Clear all notifications" onClick={() => void window.omnicode.notifications.clear().then(setSnapshot).catch(() => setError('Could not clear notifications.'))}><Trash2 />Clear all</button><span>Conversation history is never deleted.</span></footer>}
    </section>}
  </div>
}
