import { BriefcaseBusiness, Code2 } from 'lucide-react'

import type { AppMode } from '../../../../shared/work-contracts'
import './ModeSwitcher.css'

const MODES: ReadonlyArray<{
  id: AppMode
  label: string
  description: string
  icon: typeof Code2
}> = [
  { id: 'code', label: 'Code', description: 'Software development workspace', icon: Code2 },
  { id: 'work', label: 'Work', description: 'AI work assistant', icon: BriefcaseBusiness }
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
  return <div className="mode-switcher" role="radiogroup" aria-label="OmniCode mode">
    {MODES.map((mode) => {
      const Icon = mode.icon
      return <button
        type="button"
        role="radio"
        aria-checked={value === mode.id}
        className={value === mode.id ? 'active' : ''}
        disabled={disabled}
        key={mode.id}
        title={mode.description}
        onClick={() => onChange(mode.id)}
      >
        <Icon />
        <span>{mode.label}</span>
      </button>
    })}
  </div>
}
