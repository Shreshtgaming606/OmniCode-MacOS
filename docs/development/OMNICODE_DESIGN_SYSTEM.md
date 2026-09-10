# OmniCode Design System

This document is the source of truth for OmniCode's renderer visual language.
It covers both Code Mode and Work Mode without changing either mode's product
boundaries or lifecycle.

## Principles

- **Native first.** Controls should feel at home on macOS: compact, quiet,
  legible, keyboard accessible, and visually subordinate to user content.
- **One shell, two modes.** Code and Work share the titlebar, color system,
  focus treatment, feedback patterns, and motion language. Their workspace
  layouts remain intentionally distinct.
- **State must be honest.** Loading, unavailable, disconnected, failed,
  destructive, and successful states are visually distinct and backed by real
  application state. A visual success state must never substitute for a
  completed operation.
- **Depth is functional.** Borders separate adjacent work areas, shadows lift
  transient surfaces, and translucency is reserved for chrome and overlays.
- **Motion explains change.** Short transitions communicate selection,
  hierarchy, or arrival. Continuous decorative animation is avoided.

## Foundations

The implementation lives in `src/renderer/src/styles.css`. Component styles
must consume these variables rather than introducing a parallel scale.

### Spacing

| Token | Value | Typical use |
| --- | ---: | --- |
| `--space-1` | 4px | icon gaps and compact insets |
| `--space-2` | 8px | control padding and row gaps |
| `--space-3` | 12px | cards and compact sections |
| `--space-4` | 16px | standard section padding |
| `--space-5` | 20px | roomy panel padding |
| `--space-6` | 24px | section separation |
| `--space-8` | 32px | large composition spacing |
| `--space-10` | 40px | empty-state spacing |

### Shape

- `--radius-xs`: 4px for tiny embedded controls.
- `--radius-sm`: 6px for toolbar controls and compact rows.
- `--radius-md`: 9px for inputs and menus.
- `--radius-lg`: 12px for cards and composers.
- `--radius-xl`: 16px for prominent transient surfaces.
- `--radius-pill`: 999px for badges and segmented controls.

### Typography

OmniCode uses the macOS system font stack for UI and SF Mono-compatible fonts
for code. The supported UI scale is 11, 12, 13, 15, 18, 24, and 30px. Text
smaller than 11px is reserved for nonessential badges and is not used for
instructions, status errors, or interactive labels.

### Color and elevation

Semantic surfaces are exposed as `--bg-app`, `--bg-title`, `--bg-sidebar`,
`--bg-editor`, `--bg-panel`, `--bg-raised`, `--bg-overlay`, `--bg-input`,
`--bg-hover`, and `--bg-active`. Text uses `--text`, `--text-secondary`, and
`--text-muted`. Feedback uses `--accent`, `--success`, `--warning`, and
`--danger` with derived translucent backgrounds.

Elevation progresses through `--shadow-xs`, `--shadow-sm`, `--shadow-md`, and
`--shadow-lg`. Permanent split panels use borders, not shadows. Menus, popovers,
dialogs, and toasts may use elevation.

Light, dark, and system appearances share semantic names. Components must not
infer the active appearance from hard-coded RGB values.

## Motion

| Token | Duration | Use |
| --- | ---: | --- |
| `--motion-fast` | 120ms | hover, pressed, focus feedback |
| `--motion-base` | 180ms | selection and segmented controls |
| `--motion-slow` | 240ms | popovers, toasts, panel arrival |

`--ease-standard` is used for ordinary state transitions and
`--ease-emphasized` for small spatial movement. Mode changes animate only the
selection indicator; Code and Work remain mounted so switching never discards
editor, terminal, conversation, or model state.

When macOS Reduce Motion is enabled, duration tokens collapse to `1ms`, smooth
scrolling is disabled, transforms are removed from arrival animation, and
loading state remains understandable through labels or static indicators.

## Component states

Interactive components must define, as applicable:

1. Resting
2. Hover
3. Pressed
4. Keyboard focus (`:focus-visible`)
5. Selected/current
6. Disabled
7. Loading
8. Success, warning, or error

Every icon-only button requires an accessible name. Native tooltips (`title`)
are accepted for compact workbench controls; application-owned popovers should
use a shared tooltip component once one is needed for rich content. Icons are
from Lucide unless an official service mark is required. Emoji and text glyphs
must not be used as functional icons.

## Layout rules

- The shared titlebar is 50px high and uses macOS hidden-inset traffic lights.
- Toolbars and status bars stay compact; primary actions are at least 30px high.
- Resizable panel separators expose a larger pointer target than their visible
  one-pixel rule.
- Code Mode prioritizes editor density and hierarchy.
- Work Mode prioritizes readable message width, conversation navigation, clear
  model/privacy state, and an anchored composer.
- Empty states offer actions that are currently available. Connected-app
  suggestions are displayed only when the required service is actually
  connected and authorized.

## Accessibility and performance

- Keyboard focus is never represented by color alone.
- Status changes use `role="status"` or `role="alert"` where interruption is
  appropriate.
- Contrast is checked in both appearances, including muted text and disabled
  controls.
- Decorative blur is limited to titlebar/overlay surfaces; large scrolling
  surfaces remain opaque.
- Animations use opacity and transforms and do not continuously animate idle
  editor, terminal, or workspace content.

## Review checklist

Before a new or changed surface is considered complete:

- it uses semantic tokens and the shared icon language;
- all relevant states are visible and backed by real behavior;
- keyboard operation and focus are verified;
- light, dark, system, and reduced-motion modes are checked;
- resizing does not hide essential actions;
- no operation reports success before its backend completes.
