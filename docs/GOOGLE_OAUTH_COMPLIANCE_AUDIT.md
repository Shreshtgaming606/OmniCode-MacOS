# Google OAuth compliance and data-flow audit

Audit date: September 23, 2026

This is an implementation audit, not legal advice. It covers the current
working tree used to prepare the website policy.

## Claims that were unverified before the cleanup

The prior website contained these claims or implications that were not yet
supported by product behavior:

1. The legal pages were final even though they displayed draft notices,
   placeholders, and no monitored support address.
2. Google Workspace content followed a compatible AI-provider path, although
   Gmail and Drive tool results could reach any selected provider, including an
   unpaid Gemini Developer API configuration.
3. Google disconnect reliably removed local authorization, although a network
   or server failure during revocation left the Keychain record in place.
4. Temporary attachments were removed when no longer needed, although imported
   Work attachments did not cascade when their message or conversation was
   deleted and consumed service transfers could last up to one hour.
5. Omni provided local “Hey Omni” wake-word processing, although no wake-word
   listener was implemented.
6. Cursor Mode used screen observation or Screen Recording, although the
   current native helper uses Accessibility metadata and does not capture
   screenshot images.
7. The managed browser session was temporary, although its Electron partition
   used disk persistence until disconnect or a normal quit cleanup.
8. Gmail and Drive were requested only as needed, although the former OAuth
   flow requested both service scopes in one consent.
9. Basic Google identity access included an unused `profile` scope.
10. “OmniCore Technologies” could be read as a legal company rather than a
   project and brand name.

The application and website changes resolve claims 2 through 10. External
publication and Google project checks remain in `GOOGLE_OAUTH_READINESS.md`.

## Current Google data flow

```text
User request
  → task-specific Gmail or Drive search/list call
  → relevant result selected
  → content retrieved only when needed
  → ProviderPolicyManager checks the selected provider/model
      → allowed: minimum relevant context is sent
      → blocked: Google tool is not executed and the user receives an explanation
  → bounded result card and assistant summary may be stored locally
```

Historical Work messages derived from Google Workspace are marked with
`google-workspace` provenance. Switching a conversation to a blocked provider
stops the request before that history can be sent.

## Provider classification

| Route | Workspace content | Automatic? | Provider retention/training basis |
| --- | --- | --- | --- |
| Local Ollama model | Allowed | Only when needed for the user's task | Loopback inference on the Mac. No provider-side prompt store created by OmniCode. Google API traffic remains online. |
| OpenAI Chat Completions API | Allowed | Only after a user request causes a relevant tool result | `store=false`; API data not used for training by default; default abuse-monitoring logs up to 30 days. |
| Anthropic commercial Messages API | Allowed | Only after a user request causes a relevant tool result | Commercial/API data not used for training by default; automatic deletion within 30 days by default, subject to documented exceptions. |
| Gemini Developer API | Blocked | No | Paid and unpaid tiers differ and the desktop app cannot verify tier from an API key. |
| Ollama cloud model | Blocked | No | Not treated as local; hosted configuration is not independently verified. |

Policy sources are recorded in `ProviderPolicyManager` with a review date and
are linked from the public Privacy Policy.

## Storage and retention findings

- Google access and refresh tokens: macOS Keychain, deleted locally on
  disconnect even if remote revocation is unavailable.
- AI API keys: macOS Keychain.
- Work messages and summaries: local `0600` conversation store until deletion.
- Gmail/Drive result cards: bounded local previews until the owning message or
  conversation is deleted.
- Imported Work attachments: private local copies until removed or their final
  owning message/conversation is deleted; startup orphan cleanup applies.
- Gmail/Drive byte transfers: private temporary files; removed after successful
  save, email use, or Drive upload, otherwise one-hour expiry and
  shutdown/startup cleanup.
- Work action activity: bounded to 500 entries, retained until user clear.
- Omni task activity: configurable off/7/30/60/90 days, default 30 days.
- Voice audio: no audio-file persistence; on-device recognition is required.
- Submitted voice transcript: retained like the resulting message/task.
- Cursor screenshots: not captured by the current implementation.
- Managed browser storage: memory-only isolated partition.
- Diagnostics: redacted local rotating log, approximately 512 KB plus backup;
  not automatically uploaded.

## OAuth and disconnect findings

The desktop OAuth flow uses system-browser authorization, a loopback redirect,
PKCE S256, state validation, and offline access. Gmail and Drive permissions are
requested incrementally. The refresh token and access-token metadata are stored
in Keychain. Disconnect makes a best-effort Google revocation call, always
deletes the Keychain grant, and refreshes both Google connector states.

The exact scope analysis is in `GOOGLE_OAUTH_VERIFICATION.md`.
