# Google OAuth Production Guide

Last updated: 2026-09-13

## User-facing rule

Normal OmniCode users must never download a Google OAuth credentials JSON,
create a Google Cloud project, enter a client ID, or know where a publisher
credential is stored. A public OmniCode build carries the publisher-owned
Desktop OAuth client ID in its trusted Electron main bundle and shows one
ordinary **Connect Google account** flow for Gmail, Google Drive, and future
Google Workspace connectors.

The downloaded Google credentials JSON is a publisher/developer build input.
It is not a user credential and must never be committed, copied into source,
included as a packaged resource, logged, or exposed to the renderer. Google
classifies installed apps as public clients that cannot keep a client secret.
OmniCode therefore treats the downloaded `client_secret` only as extractable
client-identification metadata—not as authorization security. The validated
client ID and optional Desktop client secret are compiled only into the trusted
main bundle for Google endpoint compatibility; the raw JSON and its path are not
packaged. Authorization Code flow with PKCE S256, a random state value, user
consent, and a random `127.0.0.1` loopback callback provide the security
boundary.

Each user's access and refresh tokens are separate from the publisher client.
They are written only to that user's macOS Keychain, retrieved only in the main
process, refreshed there, and deleted locally when the user disconnects. The
system browser handles Google sign-in; OmniCode never asks for a Google
password and does not place OAuth tokens in renderer state, workspaces, logs,
command arguments, or model messages.

Official protocol reference: [OAuth 2.0 for Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app).

## Implemented OmniCode flow

1. The user chooses Connect on Gmail or Google Drive.
2. OmniCode opens a listener on a random `127.0.0.1` port.
3. The main process generates a high-entropy state value and PKCE verifier.
4. The macOS default browser opens Google's authorization page.
5. The exact loopback path and state are verified before accepting a code.
6. The main process exchanges the one-time code using PKCE and the Desktop
   public-client metadata expected by Google's token endpoint.
7. Google user info is fetched to prove the account can be reached.
8. The verified token record is stored in macOS Keychain.
9. Gmail and Drive status is derived from the same account and grant. A saved
   token alone is never displayed as Connected.
10. Expired access tokens refresh in the main process. Revoked or insufficient
    grants become explicit reconnect or permission states.

OmniCode requests only identity plus the service being connected:

- `openid` and `email` for account identity
- `https://www.googleapis.com/auth/gmail.modify` when the user connects Gmail
- `https://www.googleapis.com/auth/drive` when the user connects Google Drive

Google may include previously granted scopes during a later connection so one
stored grant continues to support every service the user chose. The unused
`profile` scope is not requested.

The Gmail and Drive scopes are currently classified as Restricted. Scope
classifications and descriptions are maintained in Google's
[Gmail scope guide](https://developers.google.com/workspace/gmail/api/auth/scopes)
and [Drive scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Local developer setup

Use a Google Cloud project and Desktop OAuth client reserved for testing. Google
recommends separate testing and production projects so experimental redirect,
branding, test-user, and scope changes cannot disrupt the public app.

1. Enable the Gmail API and Google Drive API in the testing project.
2. Configure the OAuth audience as External and leave publishing status at
   Testing.
3. Add each developer account as an OAuth test user.
4. Download a Desktop app credentials JSON to a private location outside the
   repository and restrict it to owner read/write access (`chmod 600`).
5. Copy `.env.example` to the ignored `.env.local` and set:

   ```text
   OMNICODE_GOOGLE_OAUTH_CREDENTIALS_FILE=/absolute/path/to/client_secret_desktop.apps.googleusercontent.com.json
   OMNICODE_GOOGLE_OAUTH_TESTING=1
   ```

6. Run `npm run build`, `npm run dist:dir`, or an architecture-specific release
   command. Build validation accepts only an absolute, bounded JSON file using
   Google's Desktop (`installed`) schema, official endpoints, a loopback
   redirect, and a valid Google Desktop client ID.
7. Launch the packaged app, connect Google, complete browser consent, quit and
   reopen the app, test a refresh, then disconnect and confirm the Keychain
   record is removed.

`.env.local`, `client_secret_*.apps.googleusercontent.com.json`,
`google-oauth-client*.json`, and `.omnicode-oauth/` are ignored. CI may instead
provide `OMNICODE_GOOGLE_OAUTH_CLIENT_ID` and the matching
`OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET` directly as protected release
configuration. Do not provide both build-input mechanisms. Although Google's
Desktop client secret is distributed and extractable, keep the downloaded file
and CI values out of source and logs. The test flag belongs to the selected
client identity and cannot be inherited across a runtime client-ID override.

In Testing status Google currently limits the app to explicitly listed test
users (up to 100) and authorizations that include non-basic scopes normally
expire after seven days. A non-test account may see an access-blocked page.
OmniCode translates an `access_denied` callback in a testing build into a clear
message directing the developer to the project's test-user list. See Google's
[OAuth app audience documentation](https://support.google.com/cloud/answer/15549945?hl=en).

## Production Google Cloud setup

Complete this checklist in the separate production Google Cloud project:

1. Enable the Gmail API and Google Drive API.
2. Create an OAuth 2.0 client of application type **Desktop app** for OmniCode.
3. Configure OAuth Branding with the public OmniCode name and production logo,
   developer/support contacts, and accurate application details.
4. Provide a public HTTPS homepage and privacy-policy page on a domain owned by
   the publisher. Verify domain ownership in Google Search Console and add the
   domain to the consent configuration. A terms-of-service page is recommended.
5. Set Audience to External. Keep Testing status while the publisher completes
   its own validation, then publish to In production for general Google users.
6. Declare only the identity, Gmail, and Drive scopes listed above. Explain why
   Gmail needs read/organize/draft/send capabilities and why Drive needs to
   search, read, organize, and transfer arbitrary user-authorized files.
7. Re-evaluate the full Drive scope before submission. Replacing arbitrary
   Drive browsing with Google Picker plus `drive.file` could reduce scope
   sensitivity, but it would be a material product/architecture change and does
   not satisfy OmniCode's currently implemented arbitrary Drive search and
   organization tools.
8. Submit the app for OAuth brand and Restricted Scope verification. Provide an
   English, unlisted demonstration video showing the relevant client ID,
   consent screen, and every product feature that uses each requested scope.
9. Ensure the public privacy policy and in-product disclosures explain what
   Google data OmniCode reads, how it is stored locally, how it is deleted, and
   that selected Gmail/Drive content can be sent to the user's chosen cloud AI
   provider only after the user requests that workflow. Obtain affirmative,
   informed consent before that transfer. Follow the Google API Services User
   Data Policy and Limited Use requirements.
10. Ask Google or an approved assessor for a written determination on the
    restricted-scope security assessment. OmniCode is local-first, but users can
    direct restricted Google content to a third-party cloud AI provider. Do not
    assume that local token storage alone exempts the app. If an assessment is
    required, complete the approved assessment and its required renewals.
11. Set the production build's protected `OMNICODE_GOOGLE_OAUTH_CLIENT_ID` and
    matching `OMNICODE_GOOGLE_OAUTH_CLIENT_SECRET` to the verified production
    Desktop client metadata. Do not mark the production build as testing and do
    not upload the downloaded JSON as an app resource. Never treat this
    extractable Desktop value as proof that a caller is trusted.
12. Sign the exact release with the Apple Developer ID certificate, notarize it,
    run the packaged OAuth/Gmail/Drive verification matrix, and retain evidence
    matching the client and binaries submitted to Google.

Primary production references:

- [OAuth production policy compliance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
- [Sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [OAuth verification requirements](https://support.google.com/cloud/answer/13464321?hl=en)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)

## Publisher release gate

A public OmniCode build is not ready until all items below are recorded as
passing or externally approved:

- The production client ID is embedded; the testing client ID and testing marker
  are absent.
- No raw credentials JSON, JSON path, user token, or authorization header appears
  in source, Git, logs, diagnostics, renderer storage, conversation history, DMG,
  or ZIP. The matching Desktop client ID/secret metadata may appear only in the
  trusted main bundle and must be assumed extractable from the distributed app.
- Brand, homepage, privacy policy, verified domain, audience, and declared scopes
  match the shipped app.
- Google verification and any required security assessment are complete.
- A non-developer user can connect through the normal system-browser experience
  without a JSON file or Google Cloud instructions.
- One consent connects the shared Google account and both Gmail and Drive verify
  against their real APIs.
- Restart persistence, access-token refresh, revoked-grant recovery, reconnect,
  and disconnect/revoke pass on the signed packaged build.
- Gmail read/draft/send and Drive read/write workflows pass with safe test data;
  exact confirmation and model-data disclosures remain enforced.
- Intel and Apple Silicon installers are signed, notarized, and tested on their
  matching hardware.

Developer Testing credentials may produce internal test installers, but they
must never be represented as the verified public production client.
