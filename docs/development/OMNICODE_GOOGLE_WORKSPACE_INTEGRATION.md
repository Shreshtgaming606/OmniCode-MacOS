# OmniCode Google Workspace Integration

## Status

The production connector code, permission boundary, opaque transfer layer, and
automated integration coverage are implemented. A real publisher-owned Desktop
OAuth client is now configured locally as an ignored developer build input; its
downloaded JSON is not part of source, Git, or packaged app resources. Its
Desktop public-client metadata is compiled only into the trusted main bundle
and is not treated as confidential. A listed test account completed real
system-browser consent, both services verified the same account, the grant
survived app restart through Keychain, and minimal read-only Gmail and Drive API
calls passed. OmniCode's Gemini API-key integration is separate: a Gemini API
key is not a Google Workspace OAuth credential and cannot authorize Gmail or
Drive.

Gmail registers 13 real tools and Drive registers 15. Results are projected into
small email/file cards using display-only fields; internal Gmail/Drive IDs,
provider URLs, raw response bodies, opaque transfer IDs, tokens, local paths,
and binary bytes are never persisted in those cards. Gmail attachments and
Drive downloads use an app-private, integrity-checked transfer store so the same
Work conversation can move exact bytes between services without routing them
through the reasoning model.

## AI provider data policy

Google OAuth connection state and AI-provider eligibility are independent. A
Gmail or Drive connector stays visibly Connected when the selected model is not
permitted to receive its data. The main process supplies the model with an
authoritative availability record such as `CONNECTED_BUT_UNAVAILABLE_TO_CURRENT_MODEL_DATA_POLICY`,
so it cannot falsely tell the user that Gmail is disconnected.

Gemini is no longer blocked solely because its provider ID is `google`.
`ProviderPolicyManager` evaluates the selected service configuration:

- an unknown, Free, expired, or changed-key Gemini configuration is blocked;
- a Paid configuration becomes eligible only after the saved key passes Test
  Connection and the user confirms that the matching Google AI Studio project
  shows Paid;
- the manual verification is stored only as a one-way key fingerprint, expires
  after seven days, and never stores or exposes the API key;
- eligible cloud providers still require separate connected-data consent;
- consent is also credential-bound and is invalidated by credential rotation;
- historical `google-workspace` provenance is checked again before every
  provider request, so switching to an ineligible configuration cannot leak
  prior Gmail/Drive content.

Google's normal Gemini API key does not expose Paid/Free status. The supported
Cloud Billing API requires a separately authorized Cloud identity and project
IAM permission, so OmniCode does not pretend that a successful model request or
a model ID proves Paid eligibility. Paid Services and zero data retention are
also represented separately; the Gemini path does not claim zero retention.

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

OmniCode requests identity plus the service the user is connecting. Google may
include previously granted scopes during a later connection so one verified
account grant can continue to serve both services after the user chooses to
connect both. It follows this policy:

- Identity: `openid` and `email`, used to display the connected account and
  verify the token belongs to a real Google user. The unused `profile` scope is
  not requested.
- Gmail: `https://www.googleapis.com/auth/gmail.modify`. The requested product
  behavior includes reading, composing, sending, labels, read state, and
  archiving. Google's narrower send-only scope cannot satisfy the read tools.
- Drive: `https://www.googleapis.com/auth/drive`. Searching, reading, moving,
  renaming, trashing, and restoring arbitrary user-selected Drive files cannot
  be implemented with `drive.file`, which is limited to files the app creates
  or the user explicitly shares with it through a picker.

Connecting Gmail does not request Drive access, and connecting Drive does not
request Gmail access.

Both service scopes are classified as restricted by Google and require the
appropriate OAuth consent configuration, public-app verification, and possibly
additional review.

## OAuth client configuration

The desktop application requires a Google Cloud OAuth client ID created for an
installed/Desktop application with the Gmail and Drive APIs enabled. Publisher
development builds can read an ignored, absolute credentials-file path through
`OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE`; protected CI can supply the public
`OMNICODE_GOOGLE_OAUTH_CLIENT_ID` directly. `OMNICODE_GOOGLE_OAUTH_TESTING=1`
enables the accurate unauthorized-test-user explanation for a Testing client.

Installed applications cannot keep a client secret confidential. OmniCode's
build loader validates the downloaded Desktop JSON and extracts the matching
client ID plus optional Desktop client secret. The JSON path and JSON body are
never defined into the app. Google's Desktop secret cannot be confidential in a
distributed app, so it is used only as token-endpoint compatibility metadata;
PKCE, state, and user consent remain the security boundary. The renderer cannot
read the client metadata or user tokens. Normal users see only Connect Google account and never see these
publisher settings. See `GOOGLE_OAUTH_PRODUCTION.md` for testing, verification,
security-assessment, and public-release requirements.

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

The shared Google-account summary and service adapters distinguish:

- not connected;
- publisher sign-in unavailable without exposing developer configuration;
- connecting in the system browser;
- connected and verified as a named account;
- missing required permission;
- authentication expired/revoked;
- network failure;
- rate limit;
- service unavailable.

Registration or a stored token alone is never presented as Connected.

## Live verification status and remaining release work

The locally configured Testing client has now completed real system-browser
consent with an approved test account. Verified identity, shared Gmail/Drive
state, Keychain-backed restart persistence, Gmail label listing, Drive search,
renderer-token isolation, and build-input leakage checks passed in the packaged
0.3.1 app. The live probe printed only counts and changed no user data.

Before public release, the publisher must still test automatic refresh,
revocation/reconnect, Gmail draft/send and mutation flows, Drive write/organize
flows, and cross-connector transfers using disposable data and the exact native
confirmations. Those tests also need to be repeated with the verified production
client in signed/notarized Intel and Apple Silicon builds.
