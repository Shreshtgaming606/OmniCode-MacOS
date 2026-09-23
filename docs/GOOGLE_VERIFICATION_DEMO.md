# Google OAuth verification demo

Prepare a short, continuous screen recording using a dedicated test Google
account that contains only safe, synthetic email and Drive files. Do not show
personal inboxes, real access tokens, API keys, client secrets, or unrelated
browser tabs.

## Before recording

- Use the exact production candidate that will be submitted.
- Configure an approved AI route for the test, such as a local Ollama model or
  an API provider permitted by OmniCode's current provider policy.
- Put one synthetic email named “OAuth Review Project Update” in the test inbox.
- Put one synthetic file named “OAuth Review Plan.txt” in the test Drive.
- Confirm the account is an authorized test user while the OAuth app is in
  Testing.
- Start with Google disconnected in OmniCode.

## Recording script

1. Open OmniCode and identify the app by name.
2. Open Work Mode, then Connected Apps.
3. Open the Google connector and show the concise OAuth explanation and the
   Privacy Policy link.
4. Click Connect for Gmail. Complete Google OAuth in the system browser and
   show the consent screen. Explain that `gmail.modify` supports search/read,
   threads and attachments, drafts, send/reply, labels, read/unread, and
   archive. Do not grant Drive yet; this demonstrates incremental consent.
5. Return to OmniCode and show Gmail as connected.
6. Ask OmniCode to find the synthetic “OAuth Review Project Update” email and
   summarize only that result. Show the cloud/local data-path banner before the
   request.
7. Open Connected Apps and connect Google Drive. Show the additional Drive
   consent. Explain that full Drive access is needed to search arbitrary
   existing files and to support read/export, upload/download, create, rename,
   move, copy, trash, and restore; `drive.file` cannot find arbitrary existing
   files.
8. Ask OmniCode to find “OAuth Review Plan.txt,” then read only that selected
   file. Point out that search happens before content retrieval.
9. Optionally select Gemini and show that Gmail and Drive tools are blocked by
   the provider policy. Do not include real user data in this blocked test.
10. Open Settings → Privacy & Security and show the Privacy Policy, Terms of
    Service, and About OmniCode links.
11. Return to Connected Apps and click Manage Google Connection, then
    Disconnect Google. Show both Gmail and Drive as Not Connected.
12. Open the public Privacy Policy and point to the Google data, Limited Use,
    AI-provider, retention, and disconnect sections.

## Keep the explanation concise

State that OmniCode:

- uses Google OAuth and never asks for the user's Google password;
- requests Gmail and Drive incrementally;
- uses the requested scopes only for visible user-facing features;
- sends only task-relevant Google data to an approved provider route;
- blocks Gemini Developer API and Ollama cloud-model routes for Google
  Workspace content in the current build;
- stores Google tokens in macOS Keychain; and
- attempts revocation and deletes the local grant when the user disconnects.

Do not call OmniCode “Google Verified” or “Google Approved” in the recording.
