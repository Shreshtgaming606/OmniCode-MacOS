import type { KeyboardEvent } from 'react'
import { AudioWaveform, BriefcaseBusiness, Code2 } from 'lucide-react'

import type { AppMode } from '../../../../shared/work-contracts'
import './ModeSwitcher.css'

const MODES: ReadonlyArray<{
  id: AppMode
  label: string
  description: string
  icon: typeof Code2
}> = [
  { id: 'code', label: 'Code', description: 'Software development workspace', icon: Code2 },
  { id: 'work', label: 'Work', description: 'AI work assistant', icon: BriefcaseBusiness },
  { id: 'omni', label: 'Omni', description: 'Voice-first system assistant', icon: AudioWaveform }
]

export function ModeSwitcher({
  value,
  onChange,
  disabled = false
}: {
  value: AppMode
  onChange(mode: AppMode): void
  disabled?: boolean
}) {
  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number): void => {
    if (disabled) return

    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % MODES.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + MODES.length) % MODES.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = MODES.length - 1
        break
      default:
        return
    }

    event.preventDefault()
    const nextMode = MODES[nextIndex]
    onChange(nextMode.id)
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')[nextIndex]
      ?.focus()
  }

  return <div className="mode-switcher" data-active-mode={value} role="radiogroup" aria-label="OmniCode mode">
    {MODES.map((mode, index) => {
      const Icon = mode.icon
      return <button
        type="button"
        role="radio"
        aria-checked={value === mode.id}
        tabIndex={value === mode.id ? 0 : -1}
        className={value === mode.id ? 'active' : ''}
        disabled={disabled}
        key={mode.id}
        title={mode.description}
        onClick={() => onChange(mode.id)}
        onKeyDown={(event) => moveSelection(event, index)}
      >
        <Icon />
        <span>{mode.label}</span>
      </button>
    })}
  </div>
}
