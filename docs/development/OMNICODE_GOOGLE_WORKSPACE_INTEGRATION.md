# OmniCode Google Workspace Integration

## Status

The production connector code, permission boundary, opaque transfer layer, and
automated integration coverage are implemented. Live account verification is
externally blocked. OmniCode's Gemini API-key integration is separate: a Gemini
API key is not a Google Workspace OAuth credential and cannot authorize Gmail
or Drive. Gmail and Drive remain honestly disconnected until a registered
desktop OAuth client is supplied and the user grants consent in their system
browser.

Gmail registers 13 real tools and Drive registers 15. Results are projected into
small email/file cards using display-only fields; internal Gmail/Drive IDs,
provider URLs, raw response bodies, opaque transfer IDs, tokens, local paths,
and binary bytes are never persisted in those cards. Gmail attachments and
Drive downloads use an app-private, integrity-checked transfer store so the same
Work conversation can move exact bytes between services without routing them
through the reasoning model.

## Authentication architecture

OmniCode uses Google's OAuth 2.0 installed-application flow:

1. The main process opens a listener on a random `127.0.0.1` port.
2. It generates a fresh high-entropy `state` value and PKCE verifier/challenge.
3. It opens Google's authorization endpoint in the macOS default browser.
4. The callback is accepted only on the exact loopback path and only when
   `state` matches.
5. The main process exchanges the one-time code directly with Google's token
   endpoint.
6. Access and refresh tokens are stored in macOS Keychain, never renderer
   storage, workspace files, logs, command arguments, or conversation history.
7. Expiring access tokens are refreshed in the main process. Invalid grants
   become an explicit reconnect-required state.
8. Disconnect revokes the Google grant when possible and deletes the local
   Keychain item.

The system browser is required. Google blocks OAuth in embedded user agents,
and OmniCode does not collect Google passwords.

Official references:

- [OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Using OAuth 2.0 to Access Google APIs](https://developers.google.com/identity/protocols/oauth2)
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Gmail REST API](https://developers.google.com/workspace/gmail/api/reference/rest)
- [Drive REST API v3](https://developers.google.com/workspace/drive/api/reference/rest/v3)

## Scope policy

Google's installed-app documentation explicitly states that incremental
authorization is not supported for installed apps. OmniCode therefore does not
claim it can silently add one scope at a time. It follows this policy:

- Identity: `openid`, `email`, and `profile`, used to display the connected
  account and verify the token belongs to a real Google user.
- Gmail: `https://www.googleapis.com/auth/gmail.modify`. The requested product
  behavior includes reading, composing, sending, labels, read state, and
  archiving. Google's narrower send-only scope cannot satisfy the read tools.
- Drive: `https://www.googleapis.com/auth/drive`. Searching, reading, moving,
  renaming, trashing, and restoring arbitrary user-selected Drive files cannot
  be implemented with `drive.file`, which is limited to files the app creates
  or the user explicitly shares with it through a picker.

Both service scopes are classified as restricted by Google and require the
appropriate OAuth consent configuration, public-app verification, and possibly
additional review. If a second service is enabled after the first, OmniCode
reauthorizes with the complete union of the already granted scopes and the new
service scope.

## OAuth client configuration

The desktop application requires a Google Cloud OAuth client ID created for an
installed/desktop application with the Gmail and Drive APIs enabled. Developer
launches read:

- `OMNICODE_GOOGLE_OAUTH_CLIENT_ID`
- `OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET` (optional for installed clients)

Installed applications cannot keep a client secret confidential. No user token
or API credential should be placed in these variables. During `npm run build`
or either architecture-specific distribution command, electron-vite embeds the
same publisher-supplied desktop client values into the trusted main-process
bundle. Runtime environment values take precedence for development, and a
runtime client ID never inherits a secret from a different embedded client.
The renderer cannot read this configuration. A production OAuth client ID must
still be supplied by the OmniCode publisher before Gmail/Drive live verification
can pass.

## Permission and confirmation boundary

- Read tools are schema validated and run only while the connector is verified.
- Draft creation and ordinary reversible metadata changes use the configured
  connector permission policy.
- Sending or replying to email always requires a native confirmation that
  includes recipients, subject, and the exact body.
- Trash, restore, move, and other high-impact Drive actions require confirmation
  according to their action classification.
- Tokens and authorization headers never enter model context or tool results.
- Gmail/Drive content is untrusted data. Tool results instruct the agent that
  content may be quoted or summarized but must never be treated as commands.

## Connection states

The Google adapters distinguish:

- not connected;
- OAuth client not configured;
- connecting in the system browser;
- connected and verified as a named account;
- missing required permission;
- authentication expired/revoked;
- network failure;
- rate limit;
- service unavailable.

Registration or a stored token alone is never presented as Connected.

## Live verification requirements

Before release, a test account must complete the system-browser consent flow.
The audit must then verify token persistence across restart, automatic refresh,
reconnect after revocation, Gmail and Drive reads, exact confirmation before
email send, Drive mutation confirmation, cross-connector workflows, and absence
of tokens in logs or persisted conversations. Until the OAuth client and user
consent exist, these checks are **BLOCKED — USER CONFIGURATION REQUIRED**.
