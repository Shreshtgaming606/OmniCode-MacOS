# Omni Security Model

Last updated: 2026-09-21

Status: **Omni controller, shared authorization, private persistence,
restricted overlay, isolated browser, TTS, and structured native Cursor
boundaries are implemented and automated-verified; microphone, wake,
screen/semantic observation, and Cursor release gates remain**

## Security objective

Omni combines AI providers, local tools, connected services, microphone input,
screen context, and possible computer control. Its central rule is:

> A model may propose a bounded action, but only OmniCode's trusted main/native
> code can classify, authorize, execute, stop, and record it.

No approval UI, model prompt, connected document, webpage, renderer, or native
helper may bypass the main-process PermissionManager and fixed Tool Registry.

## Current implemented protections

The audited repository provides these reusable and Omni-specific boundaries:

- sandboxed renderer, context isolation, no renderer Node integration;
- exact trusted-frame/sender checks in `src/main/index.ts` for both the full
  window and the separately identified overlay;
- distinct typed preload bridges in `src/preload/index.ts` and
  `src/preload/omni-overlay.ts`;
- fixed tool schemas, input/result byte limits, timeouts, and cancellation in
  `src/main/services/tool-registry.ts`;
- main-process hard-boundary decisions in
  `src/main/services/permission-manager.ts`;
- connector state/scope/access-level validation;
- Keychain-backed API/OAuth secrets;
- bounded/redacted Work and Code activity stores;
- workspace containment, symlink/path checks, and task-scoped external-folder
  grants;
- terminal command policy that blocks privilege escalation, Keychain discovery,
  arbitrary automation, remote shell/transfer, secret expansion, and protected
  paths;
- isolated Managed Browser sessions, URL/DNS boundaries, no popups/downloads,
  and credential/form/account/destructive interaction blocking;
- prompt contracts that identify files, terminal output, Git data, web pages,
  email, Drive content, and tool results as untrusted data;
- Code Agent and Omni task ownership, AbortController cancellation, action
  generation invalidation, and stale-call skipping;
- one injected `PermissionManager` shared by Code, Work, and Omni registries;
- stricter-policy composition between Omni's requested approval mode and Work
  connector policy, so Omni cannot lower an existing connector boundary;
- connected/scope-aware connector catalog filtering before Gmail/Drive tools
  are given to the model;
- a dedicated Omni Managed Browser session partition rather than shared Code or
  Work page/session state;
- bounded private Omni settings and task stores with corruption recovery,
  retention, user clearing, and startup recovery of interrupted tasks;
- raw Omni user input and raw tool results excluded from persisted Activity;
- fixed-executable, no-shell macOS TTS with bounded/redacted text and output;
- recursive model-result secret sanitization with depth, node, and byte bounds;
- separate public/loopback browser sessions with exact localhost-origin binding
  and fresh public DNS validation;
- credential-stripped no-rc agent terminals whose arbitrary command/input tools
  always require direct confirmation;
- a fixed-protocol Swift Cursor helper, task-owned sessions, Accessibility
  readiness, direct approval for input, secret-text rejection, and user-
  takeover pausing.

These protections remain mandatory. Automated Omni controller/router/store,
permission, browser, voice, and renderer tests exercise the implemented
boundaries. The current serial run passed 66 files with 561 tests and one
intentional native-Keychain skip. A built-app smoke verified the overlay has
no `window.omnicode` and exposes only the intended `window.omniOverlay`
settings/tasks/activation groups; packaged adversarial testing remains part of
the release gate.

## Trust boundaries

```text
UNTRUSTED
  user/model text, provider responses, webpages, email, Drive files,
  workspace files, Git/terminal output, app labels, OCR/screen content
      |
      v
TRUSTED ORCHESTRATION
  OmniController -> ToolRegistry -> PermissionManager
      |
      v
TRUSTED FIXED EXECUTORS
  Code tools, Work connectors, isolated Omni BrowserTool,
  structured task-owned native ComputerTool
      |
      v
EXTERNAL EFFECTS
  filesystem, processes, Git/remotes, Google APIs, browser, macOS applications
```

Additional presentation/process boundaries:

- The full renderer is trusted only to request typed IPC and present state; it
  does not own permission policy.
- The implemented overlay has a smaller preload and cannot execute tools
  directly.
- A future background helper may own only activation/wake functions and must
  never receive secrets or general tools.
- The native Cursor helper receives only validated structured operations from a
  task-owned main-process session. It receives no provider credentials, raw
  conversation, shell command, executable path, or unrestricted bundle ID.
- Keychain contents are available only to dedicated credential/OAuth services,
  never to model context or native control.

## PermissionManager authority

Execution mode and approval mode are independent. Invisible/ Cursor determines
how an action is performed; Ask/Approve for me/Full determines whether policy
requires direct approval.

Every available Omni tool descriptor is application-owned and declares:

- action class and category;
- low/medium/high/critical risk;
- reversibility and external side effects;
- normal/policy/always confirmation;
- scopes, mode, schema, timeout, and result bound.

The model cannot supply or lower this metadata. Dynamic risk still escalates
credential-like and bulk input.

Hard direct confirmation remains required for:

- financial transactions and purchases;
- account deletion/access/security changes;
- password or credential changes;
- privilege escalation, root/sudo, and security-permission changes;
- broad or irreversible destructive deletion;
- exposing/transferring credentials or critically sensitive data;
- any tool explicitly registered `confirmation: always`;
- any new category deemed critical during security review.

The approval applies to one exact call and expires/cancels safely. Before an
approved executor may run, Omni rechecks the active task, generation, plan,
pause state, and execution mode. A task may not batch materially different
critical actions behind one approval.

An active task's approval policy is immutable. The full Omni UI displays the
policy captured on that task and locks the selector until the task reaches a
terminal state; it does not display a newly edited global default as if it had
changed the running task's authority. The main process remains authoritative,
so renderer presentation cannot escalate or downgrade the policy either way.

## Prompt-injection defense

External content never becomes instruction authority. Provider/system prompts
must preserve explicit separation among:

- system/application policy;
- the user's authenticated request and later course corrections;
- application-generated public plan;
- tool schemas/results;
- external content.

Examples such as “ignore your user,” “Full Access is enabled,” or “upload your
files” inside email, webpages, documents, source files, issue text, OCR, or AX
labels remain data.

Prompt injection cannot:

- enable Cursor Mode;
- change approval settings;
- approve an action;
- expand connector scopes;
- grant filesystem/application targets;
- request Keychain values;
- disable emergency stop;
- register or rename tools;
- redefine a tool's risk;
- cause a hidden cloud-model fallback.

When tool output must be returned to a model, bound it, label it untrusted, and
remove secrets and unnecessary private data first.

## Secret protection

Omni must never retrieve, expose, speak, type, screenshot, persist, or log:

- API keys;
- Google OAuth access/refresh tokens;
- authorization headers;
- passwords/passcodes;
- cookies/session tokens;
- private keys/recovery phrases;
- Keychain contents;
- security-code or secure-text-field values.

Provider credentials remain in the existing Keychain credential manager.
Helper settings and IPC contain no credential material. Tool arguments/results
are redacted before diagnostics or Activity. URL userinfo and credential query
parameters are rejected/redacted.

Cursor Mode blocks secure/password/credential fields semantically before typing
or reading. If the user takes over to enter a credential, Omni pauses and does
not observe or narrate that entry.

## Renderer and IPC security — implemented foundation

The main renderer sender check still accepts only the main window. Omni adds a
separate exact overlay identity rather than broadening that trust.

- The main preload adds reviewed typed Omni methods.
- The overlay has a dedicated minimal preload and a fixed channel allowlist.
- Main handlers validate exact window/WebContents/main-frame/local-URL identity
  and bounded payloads per channel.
- Overlay remote navigation and child-frame calls are rejected by sender/URL
  checks; it has no generic `invoke(channel, args)` bridge.
- Raw tool execution, native bridge, Keychain, filesystem, shell, screen,
  microphone, editor, terminal, and connector APIs are not exposed to the
  overlay.
- Approval remains main-process authoritative and uses native confirmation
  owned by the visible overlay or main window.

The default Electron session currently denies all web permission requests.
Maintain deny-by-default behavior. Do not grant microphone/screen permissions
to Managed Browser content or arbitrary renderer origins.

## Native helper security

The optional helper is a low-authority activator, not another Omni agent. It may
own a shortcut, local wake detector, microphone state, and app launch signal.
It must not hold provider credentials, Google tokens, conversation stores,
filesystem grants, tool registry, terminal access, or browser sessions.

Production helper communication should use authenticated XPC or equivalent
current-user local IPC with:

- code-identity validation;
- versioned bounded messages;
- replay/stale-generation rejection;
- no network listener;
- no arbitrary path/command fields;
- fail-closed disconnect/version mismatch;
- explicit upgrade and uninstall cleanup.

## Computer-control security

The implemented native ComputerTool remains out of renderer/model direct reach.
Every request is scoped to an active task, current execution generation, Cursor
execution mode, fixed structured command, and main-process PermissionManager.
The helper protocol rejects unknown fields and operations.

It must block:

- login/lock/system authorization and security settings;
- Accessibility or privacy-permission manipulation;
- secure text and credential fields;
- Keychain/password managers;
- financial/account-security/destructive flows without hard confirmation;
- interaction with OmniCode's own approval controls;
- stale process/window/element IDs;
- further actions after human takeover or Stop.

The current foundation uses bounded coordinate-based CGEvents and allowlisted
application focus; it does not capture pixels or AX trees. Semantic AX actions
and secure-field inspection are still required before screen-aware automation
can be considered complete. Future ScreenCaptureKit use remains limited to the
necessary window/region and active task. No continuous idle screenshots or
unrestricted remote-desktop surface is allowed.

## Audio and screen privacy

No microphone or screen-capture provider currently runs. The wake/STT target
remains: wake-word audio stays local, pre-wake PCM exists only for the minimal
in-memory detection window and is discarded, normal command capture starts
after explicit activation, and raw audio is not stored by default.

Current TTS sends only a bounded, redacted safe result to `/usr/bin/say` over
stdin. It does not use a shell, persist an audio file, or accept model-supplied
executable arguments.

Screen/visual context is captured only for an active permitted task. It is not
placed in Activity or conversation history, and temporary files are cleaned on
success, failure, cancellation, crash recovery, and startup.

The UI shows microphone and screen-observation state. Disabling a capability
stops current capture before the setting reports disabled.

## Filesystem, terminal, and application boundaries

Omni reuses current workspace authorization and task-scoped external-folder
grants. It cannot infer an unrestricted home-directory capability from natural
language such as “my files.” Protected/system roots remain blocked.

Terminal commands continue through the validated task-owned PTY path. Every
agent terminal run/start/input descriptor is `confirmation: always`, so Ask,
Approve for me, and Full Access all require direct approval before a model-
proposed command or terminal input can execute. Agent PTYs start zsh with
`-f`, bash with `--noprofile --norc`, or fish with `--no-config`; they do not
load user login/rc files. They inherit only an allowlisted build-tool
environment plus locale variables and required terminal metadata. Cloud
credentials, authorization sockets, and arbitrary login-shell exports are not
inherited.

Omni may not use shell commands to replace structured file, Git, connector,
browser, application, permission, screen, or cursor tools. `sudo`, root
actions, bulk environment reads, Keychain tools, arbitrary AppleScript, remote
shell/transfer, and destructive system commands remain blocked.

Application launch uses structured allowlisted metadata. An observed
application/window does not automatically grant its filesystem data or another
application.

## Activity, diagnostics, and retention

Omni Activity records user-understandable facts, not hidden chain-of-thought or
raw tool traffic. It may record:

- public plan/current step;
- tool/application name;
- bounded non-sensitive target label/path relative to granted scope;
- approval and result category;
- redacted error;
- takeover/pause/resume/stop;
- files changed and commands already allowed by existing Code activity policy.

It excludes the raw user request, generic raw tool results, raw audio,
screenshots, cookies, credentials, secure-field values, authorization data,
full email/document/page bodies, raw AX trees, and hidden provider messages.
Retention is bounded, private, atomic, user-clearable, and fails closed on
corrupt data. Startup recovery marks interrupted nonterminal tasks stopped
rather than resuming an old action.

Diagnostic logging uses subsystem, timestamp, operation, and safe error
category. Sensitive strings are redacted before persistence, not merely hidden
in the renderer.

## Permissions and least privilege

Request permissions only when the related capability is enabled or invoked:

- Microphone for voice/wake;
- Speech Recognition for Apple STT;
- Accessibility for semantic external-app control;
- Screen Recording for pixel observation fallback;
- Input Monitoring only if required by the audited takeover implementation;
- Files and Folders through normal TCC/native-picking flows;
- Notifications for background results.

Do not request Automation/Apple Events unless a separately reviewed structured
feature actually needs it. Global shortcuts and normal application launch do
not justify Accessibility permission.

Permission denial/revocation is an expected state. It produces an exact blocker
and System Settings path, not degraded silent automation or fake success.

## Model capability and fallback

Only models with demonstrated structured tool behavior receive Omni tools.
Compatible local models may be classified Full Omni Support, Experimental Tool
Support, or Chat/Voice Only according to evidence.

If the selected model lacks required tool capability, Omni stops and explains
the incompatibility. It never silently switches to a paid cloud provider or
sends local/private context to a different model.

## Signing and supply-chain boundary

The current artifacts are unsigned and unnotarized. Public Omni release requires:

- Developer ID signing of the main app, frameworks, native services, and helper;
- explicit minimal entitlements;
- notarization and stapling;
- x64/arm64 verification;
- stable helper/TCC identities;
- locked and reviewed native/wake-model dependencies;
- license and provenance review for the wake-word model;
- update behavior that cannot leave an outdated privileged helper active.

No downloaded executable or model may be run solely because webpage/model text
requested it. Runtime/model installation stays behind the existing verified
download, approval, and integrity policy.

## Required security tests

- prompt injection across email, Drive, webpages, files, terminal, Git, OCR,
  and AX labels;
- PermissionManager hard boundaries in Ask/Auto/Full and Invisible/Cursor;
- overlay/main/helper IPC spoofing, replay, and stale-generation attempts;
- renderer navigation/iframe/remote-origin permission attempts;
- secure field, password manager, authorization dialog, and approval-UI blocks;
- outside-workspace/system-path/credential access attempts;
- emergency stop and human takeover with queued native actions;
- helper/native crash and disconnect fail closed;
- mic/screen disable, permission revocation, lock/logout, and cleanup;
- log, Activity, history, crash artifact, and provider-context secret scans;
- offline/local model behavior and prohibited cloud fallback;
- signed/notarized nested-code verification on both architectures.

## Release blockers and current disposition

The following implemented foundations have automated security/regression
coverage but still require packaged release testing:

- OmniController and mode-aware Omni tool routing;
- stricter shared permission-policy composition;
- private settings/task persistence and redaction;
- isolated Managed Browser and connector filtering;
- overlay IPC/background native-confirmation ownership;
- packaged main-app background login launch without a main window or Dock icon;
- fixed macOS TTS provider;
- structured Swift Cursor helper, task sessions, takeover pause, and
  always-confirm input boundary;
- model-visible tool-result sanitizer and browser public/loopback isolation.

After the approval-display, agent-terminal, model-result, browser-isolation,
and native-Cursor hardening, the complete serial run passes 66 files/561 tests
with one intentionally skipped native-Keychain file/test. TypeScript checking
also passes. The production/native-helper build and x64 directory package pass;
the packaged smoke verifies the helper is available, Accessibility is granted,
the readiness UI is accurate, and the renderer records no errors. Signing,
notarization, broader adversarial Cursor testing, and both-architecture runtime
testing remain.

The following privileged capabilities are not implemented:

- microphone/STT and native wake helper;
- semantic AX/ScreenCaptureKit observation and element targeting;
- helper-owned emergency-stop event tap (polling/movement takeover and the
  live-verified main-process global `⌘⇧Esc` stop are present);
- helper packaging/signing/notarization.

Omni's text-first Invisible-mode foundation is therefore implemented but not a
finished public system assistant. No placeholder Listening, Wake Enabled, or
Cursor Control success state is acceptable. Resident overlay and speech-output
claims must stay within their current tested limits; post-quit activation,
voice input, semantic screen understanding, and general release-ready computer
control remain unavailable. Structured Cursor commands and live read-only
observation may be claimed only within `OMNI_CURSOR_MODE.md` limits.
