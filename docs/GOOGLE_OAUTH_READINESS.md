# Google OAuth readiness checklist

Status reviewed: September 23, 2026

- [x] Homepage accurately describes OmniCode
- [x] Privacy Policy finalized against the audited implementation
- [x] Terms finalized without invented legal-entity or jurisdiction claims
- [x] Support email present: `omnicoretech606@gmail.com`
- [x] No public draft language
- [x] Google Limited Use disclosure present
- [x] Google data-flow audit complete
- [x] Cloud AI provider compliance policy implemented and documented
- [x] Google Workspace data blocked from non-approved provider paths
- [x] OAuth scopes minimized and requested incrementally
- [x] Gmail scope justified against implemented features
- [x] Drive scope justified against implemented features
- [x] Google disconnect behavior covered by automated tests
- [x] macOS Keychain implementation and tests verified
- [x] In-app Privacy, Terms, and About links present
- [ ] `steampirate.life` verified in Google Search Console
- [ ] OAuth branding URLs and authorized domain confirmed in the production Google Cloud project
- [x] Verification demo script ready
- [ ] Live connect, Gmail, Drive, disconnect, and revocation flow completed with the production OAuth client and safe test account
- [ ] Google determination and, if required, completion of a restricted-scope security assessment
- [ ] All five public URLs confirmed reachable without authentication from outside the hosting network
- [ ] Public-domain phishing/reputation interception resolved
- [ ] Signed and notarized public production build available, if a download is to be offered
- [ ] No unresolved Google verification blockers

## Current decision

**NOT READY FOR GOOGLE VERIFICATION**

The application and legal text are substantially aligned, but submission must
wait for the unchecked external and release items. In particular, the public
domain was intercepted by an AT&T Smart Home Manager phishing block from the
audit network and HTTPS could not be validated there. Search Console ownership,
production OAuth branding/client configuration, a live safe-account test, and
Google's restricted-scope assessment decision also require manual completion.
