import type { KeyboardEvent, ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ModeSwitcher } from './ModeSwitcher'

type TestElement = ReactElement<Record<string, unknown>>

function children(node: TestElement): TestElement[] {
  const value = node.props.children as TestElement | TestElement[]
  return Array.isArray(value) ? value : [value]
}

function pressKey(button: TestElement, key: string, buttonCount = 3) {
  const targets = Array.from({ length: buttonCount }, () => ({ focus: vi.fn() }))
  const preventDefault = vi.fn()
  const querySelectorAll = vi.fn(() => targets)
  const event = {
    key,
    preventDefault,
    currentTarget: { parentElement: { querySelectorAll } }
  } as unknown as KeyboardEvent<HTMLButtonElement>

  ;(button.props.onKeyDown as (keyboardEvent: KeyboardEvent<HTMLButtonElement>) => void)(event)
  return { preventDefault, querySelectorAll, targets }
}

describe('ModeSwitcher', () => {
  it('renders Code, Work, and Omni as selectable modes', () => {
    const tree = ModeSwitcher({ value: 'code', onChange: () => undefined }) as TestElement
    const buttons = children(tree)

    expect(buttons.map((button) => button.key)).toEqual(['code', 'work', 'omni'])
    expect(buttons.map((button) => button.props['aria-checked'])).toEqual([true, false, false])
    expect(buttons.map((button) => button.props.tabIndex)).toEqual([0, -1, -1])
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

  it('reports an Omni mode selection without mutating mode itself', () => {
    const onChange = vi.fn()
    const tree = ModeSwitcher({ value: 'code', onChange }) as TestElement
    const omniButton = children(tree)[2]

    ;(omniButton.props.onClick as () => void)()

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('omni')
    expect(omniButton.props['aria-checked']).toBe(false)
  })

  it('moves selection and focus with arrow keys, including wraparound', () => {
    const onChange = vi.fn()
    const workTree = ModeSwitcher({ value: 'work', onChange }) as TestElement
    const right = pressKey(children(workTree)[1], 'ArrowRight')

    expect(right.preventDefault).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenLastCalledWith('omni')
    expect(right.targets[2].focus).toHaveBeenCalledOnce()

    const codeTree = ModeSwitcher({ value: 'code', onChange }) as TestElement
    const left = pressKey(children(codeTree)[0], 'ArrowLeft')

    expect(onChange).toHaveBeenLastCalledWith('omni')
    expect(left.targets[2].focus).toHaveBeenCalledOnce()
  })

  it('supports Home and End without intercepting unrelated keys', () => {
    const onChange = vi.fn()
    const tree = ModeSwitcher({ value: 'work', onChange }) as TestElement
    const buttons = children(tree)

    const home = pressKey(buttons[1], 'Home')
    expect(onChange).toHaveBeenLastCalledWith('code')
    expect(home.targets[0].focus).toHaveBeenCalledOnce()

    const end = pressKey(buttons[1], 'End')
    expect(onChange).toHaveBeenLastCalledWith('omni')
    expect(end.targets[2].focus).toHaveBeenCalledOnce()

    onChange.mockClear()
    const unrelated = pressKey(buttons[1], 'Enter')
    expect(onChange).not.toHaveBeenCalled()
    expect(unrelated.preventDefault).not.toHaveBeenCalled()
    expect(unrelated.querySelectorAll).not.toHaveBeenCalled()
  })
})
