import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ModeSwitcher } from './ModeSwitcher'

type TestElement = ReactElement<Record<string, unknown>>

function children(node: TestElement): TestElement[] {
  const value = node.props.children as TestElement | TestElement[]
  return Array.isArray(value) ? value : [value]
}

describe('ModeSwitcher', () => {
  it('renders only the implemented Code and Work modes', () => {
    const tree = ModeSwitcher({ value: 'code', onChange: () => undefined }) as TestElement
    const buttons = children(tree)

    expect(buttons.map((button) => button.key)).toEqual(['code', 'work'])
    expect(buttons.map((button) => button.props['aria-checked'])).toEqual([true, false])
  })

  it('reports a Work mode selection without mutating mode itself', () => {
    const onChange = vi.fn()
    const tree = ModeSwitcher({ value: 'code', onChange }) as TestElement
    const workButton = children(tree)[1]

    ;(workButton.props.onClick as () => void)()

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('work')
    expect(workButton.props['aria-checked']).toBe(false)
  })
})
