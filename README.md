# SynaxMatrix

> **Next-generation digital storefront with secure admin panel, customer accounts, device banning, and Telegram notifications.**

A fully dynamic, cyber-themed web application built on Firebase with zero card / zero Blaze plan requirements. Open `index.html` directly in your browser — no local server needed.

---

## ✨ Features

### 🛍️ Public Storefront
- Real-time product catalog powered by Firestore
- Cyber-tech 3D dark theme with neon accents, scanlines, and grid background
- Mobile-first responsive design (works on phones, tablets, Windows / Mac / Linux)
- Tilt-effect product cards (disabled on touch devices)
- Search-engine friendly meta tags + Open Graph ready

### 🔐 Authentication & Accounts
- Email + password sign-up and login
- Password strength meter on sign-up
- Login rate limiting (auto lockout after 5 failed attempts)
- Persistent login session
- Customer **My Account** page with:
  - Profile editing (display name)
  - Order history with real-time status updates
  - Personal device fingerprint display
  - Member-since timestamp
- Password reset link via email

### ⚙️ Admin Dashboard
Hidden from public — only visible when an admin account is signed in.
- **Products**: Add / Edit / Delete with image upload (auto-compressed to <950KB base64)
- **Orders**: View, filter, mark contacted / completed / cancelled, delete
- **Users**: Browse all registered users, see fingerprints, promote / demote / delete
- **Activity**: Live visitor log (last 10 site visits) + admin audit log
- **Admins**: Manage admin roster (Owner is permanent)
- **Block List**: Ban / unban device fingerprints
- **Telegram**: Configure bot token & chat ID for order notifications
- **System**: Maintenance mode toggle (Quick Command "Shutdown" + visitor message + ETA) and link to public status page
- **System Diagnostics** (🛠 floating button): Test permissions, verify owner status, check rate-limit config, run permission probes

### 📊 Public Status Page
- Real-time health check of all 6 services (Storefront, Database, Authentication, Telegram Bot, Admin Panel, Security Layer)
- Live latency ping to Firestore and Telegram `getMe` endpoint
- 4 live metrics (Products, Users, Orders, Online)
- Recent activity feed (last 8 events: orders + admin actions)
- Auto-refresh every 30 seconds
- Public URL: `status.html` (no auth required)

### 🛠 Maintenance Mode (Quick Command)
- Toggle ON from admin → public pages redirect to a polished maintenance screen
- Auto-polls every 30s and returns users to the live site when you turn it OFF
- Customizable visitor message and ETA
- Admin pages (admin.html, account.html, status.html, 404.html) remain accessible
- Auto-shown if admin enables it from any device

### 🛡️ Visitor Log
- Every page view is logged to the `visitors` collection (page, fingerprint, email, user agent)
- Throttled to 1 entry per page per 10s per session (prevents log spam)
- Visible in admin → Activity tab as a real-time table

### 🚦 Rate Limiting
- 1 order per device per 60s (keyed by fingerprint in localStorage)
- 5 failed login attempts → 60s lockout
- Honeypot field on order form rejects bots silently
- Configurable in `firebase-config.js` → `window.SECURITY`

### 🛡️ Security
- **Device fingerprinting** via FingerprintJS — every banned device is blocked on every page
- **Hardened Firestore rules** — public reads only, writes require owner or admin
- **Content Security Policy** (CSP) meta tag restricting script/style/connect sources
- **X-Frame-Options: DENY** — prevents clickjacking
- **X-Content-Type-Options: nosniff** — prevents MIME-type sniffing
- **Referrer-Policy: strict-origin-when-cross-origin**
- **Permissions-Policy** disabling geolocation, camera, mic, payment
- **Honeypot field** on order form — silently rejects bots
- **Rate limiting** on order submission (60s cooldown per device) and login (5 attempts → 60s lockout)
- **Input validation** — email/phone format, URL filtering, max-length checks
- **HTML escaping** on all user-provided content (XSS protection)
- **No Firebase Storage** required — images stored as compressed base64 in Firestore
- **Admin login lockout** with localStorage-backed counter
- **Audit log** of admin actions (best-effort write to `config/auditLog/entries`)
- **Quick block** from user table — ban a user's device with one click
- **Maintenance mode** for instant site lockdown during incidents

### 📱 Mobile & Desktop Ready
- Hamburger menu on small screens
- Slide-in admin sidebar (off-canvas) on mobile
- Touch-friendly hit targets (min 44px)
- iOS safe-area support (`env(safe-area-inset-*)`)
- `prefers-reduced-motion` respected
- `hover: none` disables tilt effects on touch devices
- Print styles included
- Accessible: skip links, ARIA labels, focus states, keyboard navigation

### 🔔 Telegram Integration
- Per-order Markdown notification with customer details
- Bot token & chat ID stored in Firestore (not in client code)
- Test button to verify bot connectivity

---

## 🛠️ Tech Stack

| Layer    | Technology                              |
|----------|------------------------------------------|
| Frontend | Vanilla HTML5 / CSS3 / JavaScript (no framework) |
| Backend  | Firebase Auth + Firestore                |
| Hosting  | GitHub Pages (static, no server)         |
| Fonts    | Orbitron, Rajdhani, JetBrains Mono (Google Fonts) |
| Fingerprint | FingerprintJS v3 (CDN)               |
| Notifications | Telegram Bot API (no SDK needed)  |

---

## 📁 File Structure

```
SynaxMatrixweb/
├── index.html          # Public storefront
├── admin.html          # Admin login + dashboard
├── account.html        # Customer account panel
├── 404.html            # Access-denied landing
├── status.html         # Public system status page
├── maintenance.html    # Maintenance mode landing
├── styles.css          # All styles (cyber theme + responsive)
├── firebase-config.js  # Firebase init + constants
├── main.js             # Storefront logic
├── admin.js            # Dashboard logic + diagnostics
├── account.js          # Customer panel logic
├── maintenance.js      # Maintenance page polling logic
├── status.js           # Status page health-check logic
├── robots.txt          # SEO crawler rules
├── .nojekyll           # Tells GitHub Pages to serve as-is
├── .gitignore          # Excludes OS / IDE files
├── SECURITY.md         # Security policy & reporting
└── README.md           # You are here
```

---

## 🚀 Quick Start

### Option 1 — Local (file://)
Just open `index.html` in Chrome / Edge / Firefox. The Firebase compat scripts work without a server.

### Option 2 — GitHub Pages
1. Push this folder to `https://github.com/yossefamr/SynaxMatrixweb`
2. Go to **Settings → Pages**
3. Source: **Deploy from a branch** → `main` / `(root)`
4. Site will be live at `https://yossefamr.github.io/SynaxMatrixweb/`

### First-time setup
1. Create a Firebase project at https://console.firebase.google.com
2. Enable **Email/Password** authentication
3. Enable **Firestore** (any region)
4. Replace the config in `firebase-config.js` if you want to use a different project
5. Publish the Firestore security rules (see below)
6. Register your owner account — it becomes the permanent admin automatically
7. Open `admin.html`, sign in, go to **Telegram** tab, configure your bot

---

## 🔒 Firestore Security Rules

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /products/{id} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.email == 'ya2190069@gmail.com';
    }
    match /blockedDevices/{id} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.email == 'ya2190069@gmail.com';
    }
    match /users/{uid} {
      allow read: if true;
      allow create: if request.auth != null && request.auth.uid == uid;
      allow update: if request.auth != null && (request.auth.uid == uid || request.auth.token.email == 'ya2190069@gmail.com');
      allow delete: if request.auth != null && request.auth.token.email == 'ya2190069@gmail.com';
    }
    match /orders/{id} {
      allow create: if true;
      allow read: if request.auth != null && (request.auth.token.email == 'ya2190069@gmail.com' || resource.data.userId == request.auth.uid);
      allow update, delete: if request.auth != null && request.auth.token.email == 'ya2190069@gmail.com';
    }
    match /config/{id} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.email == 'ya2190069@gmail.com';
    }
    match /config/auditLog/{document=**} {
      allow read, write: if request.auth != null && request.auth.token.email == 'ya2190069@gmail.com';
    }
  }
}
```

> **Note:** The owner email is hardcoded as the single source of admin power. If you fork this project, change `'ya2190069@gmail.com'` to your own email and re-publish the rules.

---

## 🎨 Customization

| What | Where |
|------|-------|
| Brand name | `index.html`, `admin.html`, `account.html` — search `SYNAX<span class="dot">.</span>MATRIX` |
| Colors | `styles.css` — `--primary`, `--secondary`, `--accent`, `--danger` |
| Currency | `firebase-config.js` — `window.CURRENCY` |
| Owner email | `firebase-config.js` + `firestore.rules` (must match) |
| Telegram token | Admin panel → Telegram tab (saved to Firestore) |
| Rate limits | `firebase-config.js` — `window.SECURITY` |
| Hero text | `index.html` `<section class="hero">` |

---

## 🧪 Testing Checklist

- [ ] Open `index.html` — products load
- [ ] Sign up a new account — redirected to user menu
- [ ] Place an order — appears in admin dashboard
- [ ] Sign in to `admin.html` with owner account — dashboard loads
- [ ] Run **🛠 Diagnostics** — all 4 permission tests pass
- [ ] Add a product with image — appears on storefront
- [ ] Configure Telegram — receive test message
- [ ] Open in mobile view (DevTools) — hamburger menu works
- [ ] Block a device from admin — that device gets redirected to `404.html`

---

## 📊 Admin Stats

The dashboard shows in real time:
- **Total products** and **average price** (EGP)
- **Registered users** count
- **Online now** (active in last 2 min) and **offline** users
- **Blocked devices** count
- **Pending orders** badge in the sidebar

---

## 🌐 Browser Support

| Browser | Version | Status |
|---------|---------|--------|
| Chrome  | 90+     | ✅ Full |
| Edge    | 90+     | ✅ Full |
| Firefox | 88+     | ✅ Full |
| Safari  | 14+     | ✅ Full |
| Opera   | 76+     | ✅ Full |
| IE 11   | —       | ❌ Not supported |

---

## 📜 License

MIT License — do whatever you want, but don't blame us if it breaks.

---

## 🙏 Credits

- **Orbitron** font by Matt McInerney
- **Rajdhani** font by Indian Type Foundry
- **JetBrains Mono** font by JetBrains
- **FingerprintJS** by FingerprintJS Inc
- **Firebase** by Google

---

**Built with ⚡ by yossefamr · 2026**
