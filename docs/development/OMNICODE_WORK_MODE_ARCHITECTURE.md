# OmniCode Work Mode Architecture

Last updated: 2026-09-09

Status: **Core 0.2.0 implementation verified; external OAuth and rich-document
formats remain blocked/not implemented**

This document describes the expansion phase that follows the completed 0.1.1
stabilization audit. Work Mode is a separate application mode alongside the
existing Code Mode. It is not a rename of Code Chat or Code Agent, and it must
not replace, reset, or silently unmount the verified development workbench.

## Baseline

- Electron 44 owns trusted filesystem, Git, Keychain, AI, terminal, server,
  diff, installer, and diagnostic services in the main process.
- A sandboxed React 19 renderer reaches those services through a typed,
  trusted-frame preload bridge.
- `App.tsx` owns a shared host around persistent Code and Work mode shells. The
  Code workbench remains mounted when Work Mode is active.
- `AIManager` is the compatibility facade for Ollama, OpenAI, Anthropic, and
  Gemini. Credentials stay in macOS Keychain.
- Code Chat and Code Agent are workspace-specific surfaces. Work conversations
  require independent identity, history, model selection, attachments, and
  tools.
- Git URL cloning, explicit repository inspection/import, progress,
  cancellation, and automatic Code/Source Control transitions are implemented.

## Mode boundary

The active application mode is currently one of:

- `code` — existing editor, Explorer, terminal, Run, server, Git, models, and
  coding AI.
- `work` — persistent personal/work conversations, attachments, connector
  activity, and permission-gated Work tools.

Only these two modes are registered. A future mode can be added through the mode
registry later; it is intentionally not named or displayed now.

The shared title bar owns the mode switcher. Code-specific commands and drag
handling are active only in Code Mode. Finder file opens and repository imports
switch to Code Mode. The Code workbench remains mounted during a mode switch so
open editors, dirty buffers, terminal sessions, and running servers survive.

## Shared and mode-specific systems

```text
App host
├── shared title bar, mode switcher, settings, dialogs, notifications
├── Code Mode shell
│   └── editor, terminal, Git, server, run/compile, Code Chat, Code Agent
└── Work Mode shell
    └── history, conversation, attachments, connector activity, Work tools

Shared trusted main-process services
├── credential manager and provider adapters
├── model catalog and per-surface model selection
├── conversation engine
├── tool registry and permission manager
├── connector manager
└── diagnostic logger
```

Provider transports are shared; the two modes do not get separate copies of
OpenAI, Anthropic, Gemini, or Ollama implementations.

## Conversations

Work conversations are stored under OmniCode's application-support directory,
not inside a source workspace or renderer local storage. The store uses:

- validated conversation/message IDs and provider/model values;
- bounded conversation, message, attachment, and content sizes;
- serialized atomic writes;
- mode `0600` files;
- no API keys, OAuth tokens, browser cookies, or authorization headers;
- summaries separate from the bounded message window sent to a provider.

Attachments selected or dropped from the Mac are imported into a controlled
private Work data store before they can persist across restarts. Arbitrary
external paths are not permanent capabilities. Bounded text/source extraction
is implemented; PDF, Word, spreadsheet, and image parsing remains explicitly
unsupported rather than simulated.

## Model discovery

Every model surface now uses a selector. Manual cloud model-ID fields were
removed from Work, Code Chat, and Settings after the shared catalog was connected.

- OpenAI: `GET https://api.openai.com/v1/models`; account-visible IDs require a
  conservative compatibility overlay because the endpoint does not reliably
  describe chat/tool/vision support.
- Anthropic: paginated `GET https://api.anthropic.com/v1/models`; consume display
  name, token limits, and provider-declared capabilities when present.
- Gemini: paginated `GET https://generativelanguage.googleapis.com/v1beta/models`;
  include only models declaring `generateContent`.
- Ollama: installed tags plus bounded `/api/show` inspection; declared tool
  support is experimental until a real tool-call test succeeds.

Catalog entries record capability evidence (`provider-api`, `ollama-show`,
`curated`, `verified`, or `unknown`) so availability is never misrepresented as
proof of tool support. Results use a bounded user-data cache with an explicit
refresh action and honest live/cached/stale/error state.

## Trusted tool flow

```text
Model proposes a registered tool ID and structured arguments
  → main-process Tool Registry validates mode, schema, sizes, and timeout
  → Connector Manager verifies the connector state and granted scopes
  → Permission Manager applies read-only / ask-before-changes / trusted policy
  → main process shows confirmation when required
  → the same validated request executes through fixed connector code
  → bounded, redacted result returns to the conversation engine
```

Model output is untrusted input. It cannot register executors, pass arbitrary
JavaScript, access Keychain, alter confirmation arguments, or directly execute
privileged application code. Destructive and sensitive actions always require
confirmation regardless of a connector's general trust level.

## Connector order

The first production connector is a dedicated, initially read-only Browser
connector with fixed Open, Navigate, Read Visible Page, and Find Text tools. It
will use an isolated Electron session rather than the user's normal browser.
Popups, downloads, external protocols, private-network access, device
permissions, file URLs, and arbitrary AI-generated JavaScript are denied.

Google remains the next recommended external-service connector because Gmail, Drive,
and Calendar enable useful multi-app workflows. It requires a registered Google
Desktop OAuth client with Authorization Code + PKCE. A Gemini API key does not
grant Gmail, Drive, or Calendar access. Tokens must be stored in Keychain and
scopes requested incrementally.

## Repository import

The existing real clone implementation remains the base. Expansion work adds:

- explicit Open Existing Repository entry points while retaining ordinary
  folder opening;
- repository inspection with branch and sanitized remote/provider metadata;
- File menu, Welcome, command palette, and Source Control entry points;
- bounded clone progress/cancellation and real final exit state;
- runtime validation for operation IDs and clone URLs;
- rejection of embedded credentials and dangerous URL schemes;
- automatic transition to Code Mode after repository open/clone.

## Implementation sequence

1. ✅ Mode contracts, validated persistence, and shared switcher.
2. ✅ Work shell and persistent conversation CRUD/search/pin/history.
3. ✅ Shared model catalog and per-surface selectors.
4. ✅ Streaming/cancellation conversation transport.
5. ✅ Tool Registry, Connector Manager, and trusted permission enforcement.
6. ✅ Isolated read-only Browser connector and real-page tests.
7. 🟡 Private attachment import and text/source extraction; rich formats remain.
8. ✅ Repository inspection/import/progress/cancellation refinements.
9. ✅ Work settings and Connected Apps management for registered connectors.
10. ✅ Security audit, packaged Work E2E, and full Code Mode regression.

Current verification is 350 passing automated tests, one intentionally skipped
native Keychain test, a successful production build, a packaged Intel core
smoke, and a packaged Work smoke with a real browser page and live Gemini 3.7
stream. Apple Silicon execution, OAuth services, signing/notarization, Ollama,
and other credential-dependent provider checks retain explicit external gates.

## Completion rules

- A connector is not `Connected` until a real verification succeeds.
- A model is not labeled tool-capable without recorded evidence.
- A tool does not execute outside its registered mode or permission boundary.
- A write/destructive action is not successful until the connector reports a
  successful final result.
- Work Mode is not complete if Code Mode regression tests fail.
- OAuth-dependent connectors remain blocked, not simulated, until credentials
  and real service operations are available.
