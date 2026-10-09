import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import type { AppMode } from '../../../../shared/work-contracts'
import { nextTourIndex, TOUR_STEPS, type TourStep } from '../../lib/guided-tour'
import { OmniModeLogo } from '../omni/OmniModeLogo'
import './GuidedTour.css'

interface TargetRect { top: number; left: number; width: number; height: number }

function measure(target: Element): TargetRect {
  const rect = target.getBoundingClientRect()
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

function cardPosition(rect: TargetRect, cardHeight: number): { top: number; left: number } {
  const width = Math.min(320, window.innerWidth - 24)
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left))
  const below = rect.top + rect.height + 16
  const top = below + cardHeight <= window.innerHeight - 12
    ? below
    : Math.max(12, Math.min(window.innerHeight - cardHeight - 12, rect.top - cardHeight - 16))
  return { top, left }
}

export function GuidedTour({ onPrepare, onFinish }: {
  onPrepare(step: TourStep): void
  onFinish(outcome: 'completed' | 'skipped'): void
}) {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<TargetRect | null>(null)
  const cardRef = useRef<HTMLElement>(null)
  const step = TOUR_STEPS[index]

  useEffect(() => { onPrepare(step) }, [index, onPrepare, step])

  useEffect(() => {
    let target: Element | null = null
    let observer: ResizeObserver | null = null
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const update = (): void => {
      if (!target) return
      const next = measure(target)
      if (next.width && next.height) setRect(next)
    }
    timer = setTimeout(() => {
      if (cancelled) return
      target = document.querySelector(step.selector)
      if (!target) {
        if (index === TOUR_STEPS.length - 1) onFinish('completed')
        else setIndex((current) => nextTourIndex(current, 1))
        return
      }
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
      update()
      observer = new ResizeObserver(update)
      observer.observe(target)
      window.addEventListener('resize', update)
      window.addEventListener('scroll', update, true)
    }, 140)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [index, onFinish, step.selector])

  useEffect(() => {
    cardRef.current?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        const buttons = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        if (!buttons.length) return
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (event.shiftKey && (current <= 0)) { event.preventDefault(); buttons[buttons.length - 1].focus() }
        else if (!event.shiftKey && current === buttons.length - 1) { event.preventDefault(); buttons[0].focus() }
        return
      }
      if (!['Escape', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return
      if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') onFinish('skipped')
      else if (event.key === 'ArrowLeft') setIndex((current) => nextTourIndex(current, -1))
      else if (index === TOUR_STEPS.length - 1) onFinish('completed')
      else setIndex((current) => nextTourIndex(current, 1))
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [index, onFinish])

  const position = rect ? cardPosition(rect, cardRef.current?.offsetHeight ?? 230) : { top: 120, left: 24 }
  return <div className="guided-tour" data-guided-tour="true" role="presentation">
    {rect && <div className="guided-tour__spotlight" style={{ top: rect.top - 5, left: rect.left - 5, width: rect.width + 10, height: rect.height + 10 }} aria-hidden="true" />}
    <section className="guided-tour__card" style={position} role="dialog" aria-modal="true" aria-label={`OmniCode tour, step ${index + 1} of ${TOUR_STEPS.length}`} tabIndex={-1} ref={cardRef}>
      <header><span>{step.id === 'omni' && <OmniModeLogo className="guided-tour__omni-logo" />}<small>OMNICODE TOUR</small><strong>{step.title}</strong></span><button type="button" aria-label="Skip Tour" title="Skip Tour" onClick={() => onFinish('skipped')}><X /></button></header>
      <p>{step.description}</p>
      <footer><button type="button" aria-label="Back" disabled={index === 0} onClick={() => setIndex((current) => nextTourIndex(current, -1))}><ArrowLeft />Back</button><span>{index + 1} of {TOUR_STEPS.length}</span><button type="button" aria-label={index === TOUR_STEPS.length - 1 ? 'Finish Tour' : 'Next'} onClick={() => index === TOUR_STEPS.length - 1 ? onFinish('completed') : setIndex((current) => nextTourIndex(current, 1))}>{index === TOUR_STEPS.length - 1 ? 'Finish Tour' : 'Next'}<ArrowRight /></button></footer>
      <button className="guided-tour__skip" type="button" onClick={() => onFinish('skipped')}>Skip Tour</button>
    </section>
  </div>
}

export function prepareTourStep(step: TourStep, changeMode: (mode: AppMode) => void, showSettings: (value: boolean) => void): void {
  if (step.mode) changeMode(step.mode)
  showSettings(Boolean(step.settingsSection))
}
