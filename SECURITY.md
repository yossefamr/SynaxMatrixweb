# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| Latest  | :white_check_mark: |

## Security Features

This project implements the following security measures:

### Client-side
- **Content Security Policy (CSP)** — restricts script/style/connect sources
- **X-Content-Type-Options: nosniff** — prevents MIME sniffing
- **Referrer-Policy** — strict-origin-when-cross-origin
- **Permissions-Policy** — disables sensitive browser APIs
- **HTML escaping** on all user-supplied content (XSS protection)
- **Honeypot field** on order form
- **Rate limiting** on order submission (60s cooldown)
- **Login throttling** with auto-lockout after 5 failed attempts
- **Input validation** — email/phone format, max-length, URL filtering
- **Device fingerprinting** for ban enforcement
- **noindex, nofollow** on admin and account pages
- **Clickjacking protection** — set via GitHub Pages' `X-Frame-Options: DENY` HTTP header (not via `<meta>` which is ignored)

### Server-side (Firestore)
- Public reads only on non-sensitive collections
- Writes restricted to the owner email (hardcoded)
- User docs can only be edited by the owner or the user themselves
- Orders readable only by owner or the order's user

## Reporting a Vulnerability

If you discover a security issue, please open a private issue or contact the maintainer directly. **Do not** post security vulnerabilities publicly before a fix is available.

## Firebase API Key

The Firebase web API key in `firebase-config.js` is **not a secret**. It is safe to commit to a public repository. Firebase security is enforced by the **Firestore Security Rules**, not by hiding the API key.

For more info, see [Firebase API Key FAQ](https://firebase.google.com/docs/projects/api-keys).
