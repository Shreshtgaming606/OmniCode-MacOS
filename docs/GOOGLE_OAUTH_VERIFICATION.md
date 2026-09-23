# Google OAuth verification configuration

Last reviewed: September 23, 2026

Use these public values in Google Auth Platform:

- Application name: `OmniCode`
- Application home page: `https://omnicode.steampirate.life/`
- Privacy policy: `https://omnicode.steampirate.life/privacy/`
- Terms of service: `https://omnicode.steampirate.life/terms/`
- Authorized domain: `steampirate.life`
- User support email: `omnicoretech606@gmail.com`
- Developer contact email: `omnicoretech606@gmail.com`

OmniCore Technologies is a project and brand name. It is not a registered
company or other legal entity. Do not describe it to Google as a corporation,
LLC, registered business, or legal owner. The public application identity is
OmniCode and the OAuth project must use the actual developer identity requested
by Google.

## OAuth client

OmniCode uses a desktop OAuth client with a loopback redirect URI, PKCE with
S256, state validation, and offline access. Do not place a web-client secret or
another confidential credential in the distributed desktop app. A desktop
client secret, if issued in client metadata, is not treated as confidential.

Before recording or submitting the review:

1. Configure the production Google Auth Platform project with the branding URLs
   above.
2. Move the app out of Testing only when the consent screen, test users, scopes,
   and verification material are ready.
3. Confirm the production build contains the intended desktop client ID.
4. Confirm all five public URLs return a successful page without authentication.
5. Do not claim that OmniCode is Google Verified or Google Approved.

## Search Console and domain ownership

This must be completed manually:

1. Verify `steampirate.life` in Google Search Console, preferably using the DNS
   domain-property flow.
2. Ensure the Google account completing OAuth verification is appropriately
   associated with both the Search Console property and the Google Cloud
   project.
3. Keep the DNS ownership-verification record active after verification.
4. Add `steampirate.life` under the OAuth authorized domains.

Do not remove or replace DNS records automatically as part of an application
release.

## Requested scopes

OmniCode now requests service scopes incrementally. Connecting Gmail does not
request Drive permission, and connecting Drive does not request Gmail
permission unless that permission was already granted.

| Exact scope | Purpose | Feature using it | Narrower-scope review |
| --- | --- | --- | --- |
| `openid` | Identify the Google authorization subject | Connected-account identity and grant verification | Required for OpenID Connect identity |
| `email` | Display and verify the connected account email | Google connection status | Needed so the user can see which account is connected |
| `https://www.googleapis.com/auth/gmail.modify` | Read/search Gmail and change message state | Search, read, threads, attachments, drafts, send/reply, labels, read/unread, and archive | `gmail.readonly` cannot draft, send, change labels/read state, or archive. `gmail.compose` cannot support the read/search and organization workflow. The implemented feature set needs `gmail.modify`. |
| `https://www.googleapis.com/auth/drive` | Find and manage files across the user's Drive | Search anywhere, recent/folder listing, metadata, read/export, download, upload, create folders, rename, move, copy, trash, and restore | `drive.file` is limited to files the app creates or the user selects for the app and cannot support “find my resume anywhere in Drive.” The implemented whole-Drive search and organization workflow needs the full Drive scope. |

The unused `profile` identity scope was removed because the connector UI does
not need the account's display name or profile image. No unused Google service
scope was retained “just in case.” The application previously requested Gmail
and Drive in one combined consent; that behavior was also removed in favor of
incremental authorization.

Both `gmail.modify` and full `drive` are restricted scopes. Plan for Google to
request detailed justification and determine whether an independent security
assessment is required for the release architecture. Do not represent that an
assessment has been completed until Google confirms and the assessment is
actually finished.

## Scope justification summary for reviewers

Gmail modification access is used by implemented features, not only future
plans: OmniCode can search and read messages, retrieve threads and attachments,
create drafts, send or reply after approval, change labels and read state, and
archive by removing the inbox label.

Full Drive access is used because OmniCode supports discovery and organization
across the user's existing Drive. It can search for arbitrary existing files,
read/export a selected result, upload and download files, create folders,
rename, move, copy, trash, and restore items. The file-only scope would not make
arbitrary pre-existing Drive content discoverable.

## Reviewer-facing data handling

- Tokens are stored in macOS Keychain.
- Disconnect attempts Google revocation and always removes the local Keychain
  grant, even if revocation is temporarily unreachable.
- Google-derived content is marked in local conversation provenance.
- Local Ollama, the OpenAI API, and the Anthropic API are approved routes under
  the current provider policy.
- Gemini Developer API and Ollama cloud-model routes are blocked for Gmail and
  Drive content in the current build.
- Cloud routes receive the minimum relevant context for the user's request.
- The application links directly to Privacy, Terms, and About in Settings and
  links to Privacy from the Google connector UI.

See `GOOGLE_OAUTH_COMPLIANCE_AUDIT.md` for the technical data-flow evidence and
`GOOGLE_VERIFICATION_DEMO.md` for the review recording.
