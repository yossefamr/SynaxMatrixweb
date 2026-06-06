(function () {
  "use strict";

  var BLOCKED_CACHE_MS = 5000;
  var FINGERPRINT_CACHE_KEY = "cy_fp";
  var FINGERPRINT_CACHE_TS = "cy_fp_ts";
  var FINGERPRINT_CACHE_TTL = 3600000;
  var VISIT_LOGGED_KEY = "cy_visit_logged_";
  var MAINTENANCE_CACHE_KEY = "cy_maint";
  var MAINTENANCE_CACHE_TTL = 30000;

  var blockedCache = { ids: new Set(), ts: 0 };
  var currentUser = null;
  var currentOrderProduct = null;
  var telegramConfig = null;
  var activeAuthTab = "login";
  var adminEmailsCache = [];
  var presenceInterval = null;
  var currentFingerprint = null;
  var paymentMethods = [];
  var paymentMethodsListener = null;
  var selectedPaymentMethod = null;
  var appliedCoupon = null;
  var appliedDiscount = 0;

  function isAdminEmail(email) {
    if (!email) return false;
    var lower = email.toLowerCase();
    if (lower === OWNER_EMAIL.toLowerCase()) return true;
    return adminEmailsCache.some(function (e) { return e.toLowerCase() === lower; });
  }

  function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  function isTouchDevice() {
    return ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
  }

  function sanitizeText(str) {
    if (str == null) return "";
    return String(str)
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/[<>]/g, function (m) { return m === "<" ? "&lt;" : "&gt;"; })
      .trim();
  }

  function validateEmail(email) {
    if (!email) return false;
    if (email.length > 254) return false;
    return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email.trim());
  }

  function validatePhone(phone) {
    if (!phone) return false;
    var cleaned = phone.replace(/[\s\-()]/g, "");
    return /^\+?[0-9]{6,20}$/.test(cleaned);
  }

  function containsUrl(text) {
    if (!text) return false;
    return /(https?:\/\/|www\.)/i.test(text);
  }

  function recordLoginAttempt(success) {
    try {
      var key = "cy_login_attempts";
      var lockoutKey = "cy_login_lockout_until";
      var now = Date.now();
      if (success) {
        localStorage.removeItem(key);
        localStorage.removeItem(lockoutKey);
        return;
      }
      var attempts = parseInt(localStorage.getItem(key) || "0", 10) + 1;
      localStorage.setItem(key, String(attempts));
      if (attempts >= (SECURITY.MAX_LOGIN_ATTEMPTS || 5)) {
        localStorage.setItem(lockoutKey, String(now + (SECURITY.LOGIN_LOCKOUT_MS || 60000)));
        sendTelegramAlert("🔒 LOGIN LOCKOUT TRIGGERED", {
          "Failed Attempts": String(attempts),
          "Lockout Duration": (SECURITY.LOGIN_LOCKOUT_MS / 1000) + "s",
          "Note": "Too many failed login attempts on the storefront."
        });
      }
    } catch (e) { /* localStorage may be disabled */ }
  }

  function isLoginLocked() {
    try {
      var until = parseInt(localStorage.getItem("cy_login_lockout_until") || "0", 10);
      if (!until) return false;
      if (Date.now() < until) {
        var secs = Math.ceil((until - Date.now()) / 1000);
        return "Too many failed attempts. Try again in " + secs + "s";
      }
      localStorage.removeItem("cy_login_lockout_until");
      localStorage.removeItem("cy_login_attempts");
      return false;
    } catch (e) { return false; }
  }

  async function saveFingerprintForUser(user) {
    if (!user) return;
    try {
      var fp = await getFingerprint();
      var userRef = db.collection(COLLECTIONS.USERS).doc(user.uid);
      var existing = await userRef.get();
      var update = {
        email: user.email,
        displayName: user.displayName || user.email.split("@")[0],
        fingerprint: fp,
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (!existing.exists) {
        update.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        update.fingerprintHistory = [fp];
      } else {
        var data = existing.data() || {};
        var history = Array.isArray(data.fingerprintHistory) ? data.fingerprintHistory.slice() : [];
        if (history.indexOf(fp) === -1) {
          history.push(fp);
          if (history.length > 5) history = history.slice(-5);
        }
        update.fingerprintHistory = history;
        if (data.fingerprint && data.fingerprint !== fp) {
          update.previousFingerprint = data.fingerprint;
          update.fingerprintChangedAt = firebase.firestore.FieldValue.serverTimestamp();
        }
      }
      await userRef.set(update, { merge: true });
    } catch (e) { console.warn("saveFingerprintForUser failed:", e); }
  }

  async function logVisit() {
    if (typeof db === "undefined") return;
    try {
      var page = window.location.pathname.split("/").pop() || "index.html";
      var flagKey = VISIT_LOGGED_KEY + page;
      var last = parseInt(sessionStorage.getItem(flagKey) || "0", 10);
      if (last && Date.now() - last < (SECURITY.VISITOR_LOG_THROTTLE_MS || 10000)) return;
      sessionStorage.setItem(flagKey, String(Date.now()));

      var fp = await getFingerprint();
      await db.collection(COLLECTIONS.VISITORS).add({
        page: page,
        fingerprint: fp,
        userId: currentUser ? currentUser.uid : null,
        email: currentUser ? currentUser.email : null,
        isAdmin: isAdminEmail(currentUser && currentUser.email),
        isLoggedIn: !!currentUser,
        userAgent: navigator.userAgent.slice(0, 200),
        referrer: (document.referrer || "").slice(0, 200) || null,
        screen: (screen.width || 0) + "x" + (screen.height || 0),
        lang: (navigator.language || "").slice(0, 10),
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { /* silent fail */ }
  }

  async function checkMaintenance() {
    if (typeof db === "undefined") return false;
    var path = window.location.pathname;
    if (path.indexOf("maintenance.html") !== -1 ||
        path.indexOf("admin.html") !== -1 ||
        path.indexOf("404.html") !== -1 ||
        path.indexOf("status.html") !== -1) {
      return false;
    }
    try {
      var cached = sessionStorage.getItem(MAINTENANCE_CACHE_KEY);
      if (cached) {
        try {
          var parsed = JSON.parse(cached);
          if (parsed && Date.now() - parsed.ts < MAINTENANCE_CACHE_TTL) {
            if (parsed.enabled) {
              window.location.replace("maintenance.html");
              return true;
            }
            return false;
          }
        } catch (e) { /* */ }
      }

      var doc = await db.collection(COLLECTIONS.CONFIG).doc("maintenance").get();
      var enabled = doc.exists && doc.data().enabled === true;
      try { sessionStorage.setItem(MAINTENANCE_CACHE_KEY, JSON.stringify({ enabled: enabled, ts: Date.now() })); } catch (e) {}
      if (enabled) {
        window.location.replace("maintenance.html");
        return true;
      }
    } catch (e) { /* fail open */ }
    return false;
  }

  function startPresence(user) {
    if (presenceInterval) clearInterval(presenceInterval);
    var update = function () {
      db.collection(COLLECTIONS.USERS).doc(user.uid).update({
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(function () {});
    };
    update();
    presenceInterval = setInterval(update, 60000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) update();
    });
  }

  function stopPresence() {
    if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null; }
  }

  function startAdminListListener() {
    db.collection(COLLECTIONS.CONFIG).doc("admins").onSnapshot(function (snap) {
      adminEmailsCache = snap.exists ? (snap.data().emails || []) : [];
      if (currentUser) updateNavUser(currentUser);
    }, function () {});
  }

  function startPaymentMethodsListener() {
    if (paymentMethodsListener) paymentMethodsListener();
    paymentMethodsListener = db.collection(COLLECTIONS.PAYMENT_METHODS)
      .where("enabled", "==", true)
      .onSnapshot(function (snap) {
        var list = [];
        snap.forEach(function (d) { list.push({ id: d.id, ...d.data() }); });
        list.sort(function (a, b) {
          var ao = a.sortOrder || 999;
          var bo = b.sortOrder || 999;
          if (ao !== bo) return ao - bo;
          return (a.name || "").localeCompare(b.name || "");
        });
        paymentMethods = list;
        renderPaymentMethods();
      }, function (err) {
        console.warn("Payment methods listener error:", err);
        var grid = document.getElementById("payment-methods-grid");
        if (grid) grid.innerHTML = '<div style="text-align:center; padding: 14px; color: var(--warn); font-size: 0.85rem;">⚠ Could not load payment methods. Refresh to retry.</div>';
      });
  }

  function renderPaymentMethods() {
    var grid = document.getElementById("payment-methods-grid");
    if (!grid) return;
    if (!paymentMethods.length) {
      grid.innerHTML = '<div style="text-align:center; padding: 20px 14px; color: var(--text-dim); font-size: 0.85rem; border: 1px dashed var(--border); border-radius: 8px;">⚠ No payment methods are currently enabled.<br /><span style="color: var(--text-muted); font-size: 0.75rem;">Contact the admin to enable a payment option.</span></div>';
      var det = document.getElementById("payment-details-section");
      var ref = document.getElementById("payment-ref-section");
      if (det) det.style.display = "none";
      if (ref) ref.style.display = "none";
      selectedPaymentMethod = null;
      return;
    }
    grid.innerHTML = "";
    paymentMethods.forEach(function (m) {
      var card = document.createElement("div");
      card.className = "payment-card";
      card.setAttribute("data-method-id", m.id);
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      var colorStyle = m.color ? "border-left: 3px solid " + escapeHtml(m.color) + ";" : "";
      card.style.cssText = colorStyle;
      card.innerHTML =
        '<div class="payment-icon" style="' + (m.color ? "color:" + escapeHtml(m.color) + ";" : "") + '">' + escapeHtml(m.icon || "💰") + '</div>' +
        '<div class="payment-info">' +
          '<div class="payment-name">' + escapeHtml(m.name) + '</div>' +
          '<div class="payment-type">' + escapeHtml((m.type || "").replace(/_/g, " ")) + '</div>' +
        '</div>' +
        '<div class="payment-check">✓</div>';
      card.addEventListener("click", function () { selectPaymentMethod(m); });
      card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectPaymentMethod(m); } });
      grid.appendChild(card);
    });
  }

  function selectPaymentMethod(method) {
    selectedPaymentMethod = method;
    var cards = document.querySelectorAll(".payment-card");
    cards.forEach(function (c) {
      var isSel = c.getAttribute("data-method-id") === method.id;
      c.classList.toggle("selected", isSel);
    });
    var det = document.getElementById("payment-details-section");
    var refSec = document.getElementById("payment-ref-section");
    if (det) {
      det.style.display = "block";
      var nameEl = document.getElementById("pd-method-name");
      var accEl = document.getElementById("pd-account");
      var accNameEl = document.getElementById("pd-account-name");
      var instrEl = document.getElementById("pd-instructions");
      if (nameEl) nameEl.textContent = method.name;
      if (accEl) accEl.textContent = method.accountNumber || "(not configured)";
      if (accNameEl) accNameEl.textContent = method.accountName ? "Account name: " + method.accountName : "";
      if (instrEl) instrEl.textContent = method.instructions || "Pay to the number above, then enter the transaction reference below.";
    }
    if (refSec) refSec.style.display = "block";
  }

  function computeDiscount(coupon, orderTotal) {
    if (!coupon) return 0;
    if (coupon.minOrderAmount && orderTotal < Number(coupon.minOrderAmount)) return 0;
    if (coupon.type === "percentage") {
      return Math.round((orderTotal * Number(coupon.value || 0)) / 100 * 100) / 100;
    } else if (coupon.type === "fixed") {
      return Math.min(Number(coupon.value || 0), orderTotal);
    }
    return 0;
  }

  function renderCouponFeedback() {
    var fb = document.getElementById("coupon-feedback");
    var applyBtn = document.getElementById("coupon-apply-btn");
    var removeBtn = document.getElementById("coupon-remove-btn");
    var inputEl = document.getElementById("coupon-input");
    if (!fb) return;
    if (appliedCoupon && appliedDiscount > 0 && currentOrderProduct) {
      var pct = appliedCoupon.type === "percentage" ? " (" + appliedCoupon.value + "%)" : "";
      fb.innerHTML = '<span style="color: var(--accent);">✓ ' + escapeHtml(appliedCoupon.code) + ' applied</span> · ' +
        'You save <strong style="color: var(--accent);">' + formatPrice(appliedDiscount) + '</strong>' +
        ' · New total: <strong style="color: var(--primary);">' + formatPrice(Math.max(0, Number(currentOrderProduct.price) - appliedDiscount)) + '</strong>' + pct;
      if (applyBtn) applyBtn.style.display = "none";
      if (removeBtn) removeBtn.style.display = "inline-block";
      if (inputEl) inputEl.disabled = true;
    } else {
      fb.innerHTML = '';
      if (applyBtn) applyBtn.style.display = "inline-block";
      if (removeBtn) removeBtn.style.display = "none";
      if (inputEl) inputEl.disabled = false;
    }
  }

  async function applyCouponFromInput() {
    if (!currentOrderProduct) return;
    var inputEl = document.getElementById("coupon-input");
    var fb = document.getElementById("coupon-feedback");
    if (!inputEl || !fb) return;
    var raw = String(inputEl.value || "").trim().toUpperCase();
    if (!raw) { fb.innerHTML = '<span style="color: var(--warn);">Please enter a code</span>'; return; }
    fb.innerHTML = '<span style="color: var(--text-dim);">Checking...</span>';
    try {
      var snap = await db.collection(COLLECTIONS.COUPONS).doc(raw).get();
      if (!snap.exists) { fb.innerHTML = '<span style="color: var(--danger);">✗ Coupon not found</span>'; appliedCoupon = null; appliedDiscount = 0; renderCouponFeedback(); return; }
      var c = snap.data();
      if (c.enabled !== true) { fb.innerHTML = '<span style="color: var(--danger);">✗ Coupon is disabled</span>'; appliedCoupon = null; appliedDiscount = 0; renderCouponFeedback(); return; }
      if (c.validUntil) {
        var d = c.validUntil.toDate ? c.validUntil.toDate() : new Date(c.validUntil);
        if (d < new Date()) { fb.innerHTML = '<span style="color: var(--danger);">✗ Coupon expired</span>'; appliedCoupon = null; appliedDiscount = 0; renderCouponFeedback(); return; }
      }
      var used = Number(c.usedCount) || 0;
      if (c.maxUses && used >= Number(c.maxUses)) { fb.innerHTML = '<span style="color: var(--danger);">✗ Coupon usage limit reached</span>'; appliedCoupon = null; appliedDiscount = 0; renderCouponFeedback(); return; }
      var orderTotal = Number(currentOrderProduct.price) || 0;
      if (c.minOrderAmount && orderTotal < Number(c.minOrderAmount)) {
        fb.innerHTML = '<span style="color: var(--danger);">✗ Minimum order ' + Number(c.minOrderAmount).toFixed(0) + ' EGP required</span>';
        appliedCoupon = null; appliedDiscount = 0; renderCouponFeedback(); return;
      }
      var disc = computeDiscount(c, orderTotal);
      if (disc <= 0) { fb.innerHTML = '<span style="color: var(--danger);">✗ Coupon not applicable</span>'; appliedCoupon = null; appliedDiscount = 0; renderCouponFeedback(); return; }
      appliedCoupon = Object.assign({}, c, { id: raw });
      appliedDiscount = disc;
      renderCouponFeedback();
    } catch (e) {
      fb.innerHTML = '<span style="color: var(--danger);">✗ Error: ' + escapeHtml(e.message || "unknown") + '</span>';
      console.warn("applyCoupon failed:", e);
    }
  }

  function removeAppliedCoupon() {
    appliedCoupon = null;
    appliedDiscount = 0;
    var inputEl = document.getElementById("coupon-input");
    if (inputEl) inputEl.value = "";
    renderCouponFeedback();
  }

  async function getFingerprint() {
    if (currentFingerprint) return currentFingerprint;
    try {
      var cached = sessionStorage.getItem(FINGERPRINT_CACHE_KEY);
      var ts = parseInt(sessionStorage.getItem(FINGERPRINT_CACHE_TS) || "0", 10);
      if (cached && Date.now() - ts < FINGERPRINT_CACHE_TTL) {
        currentFingerprint = cached;
        return cached;
      }
    } catch (e) { /* storage disabled */ }

    if (typeof FingerprintJS === "undefined") {
      var hash = 0;
      var seed = navigator.userAgent + "|" + screen.width + "x" + screen.height + "|" + navigator.language + "|" + (navigator.hardwareConcurrency || 0) + "|" + (new Date().getTimezoneOffset());
      for (var i = 0; i < seed.length; i++) hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      currentFingerprint = "anon-" + Math.abs(hash).toString(36);
    } else {
      try {
        var fp = await FingerprintJS.load();
        var result = await fp.get();
        currentFingerprint = result.visitorId;
      } catch (e) {
        currentFingerprint = "fallback-" + navigator.userAgent.slice(0, 16).replace(/\W/g, "");
      }
    }
    try {
      sessionStorage.setItem(FINGERPRINT_CACHE_KEY, currentFingerprint);
      sessionStorage.setItem(FINGERPRINT_CACHE_TS, String(Date.now()));
    } catch (e) { /* */ }
    return currentFingerprint;
  }

  async function checkBan() {
    var now = Date.now();
    if (now - blockedCache.ts < BLOCKED_CACHE_MS && blockedCache.ids.size) {
      return blockedCache.ids;
    }
    try {
      var snap = await db.collection(COLLECTIONS.BLOCKED).get();
      var ids = new Set();
      snap.forEach(function (doc) { ids.add(doc.id); });
      blockedCache = { ids: ids, ts: now };
      return ids;
    } catch (e) {
      console.warn("Block check failed, allowing access", e);
      return new Set();
    }
  }

  async function enforceBan() {
    var fp = await getFingerprint();
    var blocked = await checkBan();
    if (blocked.has(fp)) {
      var params = new URLSearchParams({ id: fp });
      sendTelegramAlert("🚫 BLOCKED DEVICE TRIED TO ACCESS", {
        "Fingerprint": fp.slice(0, 32) + "...",
        "Page": window.location.pathname,
        "User Agent": navigator.userAgent.slice(0, 100)
      });
      window.location.replace("404.html?" + params.toString());
      return false;
    }
    try { sessionStorage.setItem("cy_fingerprint", fp); } catch (e) {}
    return true;
  }

  function showToast(msg, type, title) {
    type = type || "info";
    title = title || "";
    var container = document.getElementById("toast-container");
    if (!container) return;
    var t = document.createElement("div");
    t.className = "toast " + type;
    t.innerHTML = (title ? '<div class="toast-title">' + escapeHtml(title) + '</div>' : "") +
                  '<div class="toast-msg">' + escapeHtml(String(msg)) + '</div>';
    container.appendChild(t);
    setTimeout(function () {
      t.style.opacity = "0";
      t.style.transform = "translateX(20px)";
      t.style.transition = "all 0.3s";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 4000);
  }

  function formatPrice(n) { return CURRENCY.format(n); }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderCard(p, index) {
    var card = document.createElement("article");
    card.className = "product-card fade-in";
    card.style.animationDelay = (index * 60) + "ms";
    card.dataset.id = p.id;

    var imgStyle = p.imageUrl ? "style=\"background-image:url('" + escapeHtml(p.imageUrl) + "')\"" : "";

    card.innerHTML =
      '<span class="corner-clip tl"></span><span class="corner-clip tr"></span>' +
      '<span class="corner-clip bl"></span><span class="corner-clip br"></span>' +
      '<div class="product-image" ' + imgStyle + '>' +
        (p.category ? '<span class="badge">' + escapeHtml(p.category) + '</span>' : "") +
      '</div>' +
      '<div class="product-body">' +
        '<h3 class="product-title">' + escapeHtml(p.title || "Untitled") + '</h3>' +
        '<p class="product-desc">' + escapeHtml(p.description || "") + '</p>' +
        '<div class="product-footer">' +
          '<span class="product-price">' + formatPrice(p.price) + '</span>' +
          '<span class="product-action">View</span>' +
        '</div>' +
      '</div>';

    card.addEventListener("click", function () { openDetail(p); });
    if (!isTouchDevice()) {
      card.addEventListener("mousemove", function (e) { tiltCard(card, e); });
      card.addEventListener("mouseleave", function () { resetTilt(card); });
    }
    return card;
  }

  function tiltCard(card, e) {
    var rect = card.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width - 0.5;
    var y = (e.clientY - rect.top) / rect.height - 0.5;
    card.style.transform = "translateY(-8px) rotateY(" + (x * 6) + "deg) rotateX(" + (-y * 6) + "deg)";
  }

  function resetTilt(card) { card.style.transform = ""; }

  function openDetail(p) {
    var detail = document.getElementById("product-detail");
    var modal = document.getElementById("product-modal");
    if (!detail || !modal) return;

    detail.innerHTML =
      '<div class="detail-image" ' + (p.imageUrl ? "style=\"background-image:url('" + escapeHtml(p.imageUrl) + "')\"" : "") + '></div>' +
      (p.category ? '<span class="badge-soft">' + escapeHtml(p.category) + '</span>' : "") +
      '<h2 id="product-detail-title" style="font-family:var(--font-display); font-size:1.6rem; letter-spacing:2px; margin: 12px 0;">' + escapeHtml(p.title || "Untitled") + '</h2>' +
      '<div class="detail-id">REF: ' + escapeHtml(p.id) + '</div>' +
      '<div class="detail-price">' + formatPrice(p.price) + '</div>' +
      '<p class="detail-desc">' + escapeHtml(p.description || "") + '</p>' +
      '<button class="btn btn-primary" id="place-order-btn" style="width:100%">⚡ PLACE ORDER</button>';
    modal.classList.add("active");
    document.body.style.overflow = "hidden";
    var placeBtn = document.getElementById("place-order-btn");
    if (placeBtn) placeBtn.addEventListener("click", function () {
      closeModals();
      openOrderModal(p);
    });
  }

  function closeModals() {
    document.querySelectorAll(".modal-overlay.active").forEach(function (m) { m.classList.remove("active"); });
    document.body.style.overflow = "";
  }

  function attachPaymentEvents() {
    var copyBtn = document.getElementById("pd-copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var acc = document.getElementById("pd-account");
        if (acc && acc.textContent && acc.textContent !== "(not configured)") {
          try { navigator.clipboard.writeText(acc.textContent).then(function () { showToast("Account number copied", "success"); }); }
          catch (e) { showToast("Copy failed", "error"); }
        }
      });
    }
    var applyBtn = document.getElementById("coupon-apply-btn");
    if (applyBtn) {
      applyBtn.addEventListener("click", function () { applyCouponFromInput(); });
    }
    var removeBtn = document.getElementById("coupon-remove-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", function () { removeAppliedCoupon(); });
    }
    var couponInput = document.getElementById("coupon-input");
    if (couponInput) {
      couponInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); applyCouponFromInput(); }
      });
    }
  }

  function renderProducts(products) {
    var grid = document.getElementById("product-grid");
    var counter = document.getElementById("catalog-count");
    var stat = document.getElementById("stat-products");
    if (!grid) return;

    if (!products.length) {
      grid.innerHTML =
        '<div class="empty-state" style="grid-column: 1/-1">' +
          '<div class="icon">&#128296;</div>' +
          '<h3 style="color:var(--text); font-family:var(--font-display); letter-spacing:2px; margin-bottom: 8px;">NO PRODUCTS YET</h3>' +
          '<p>The catalog is currently empty. Check back soon.</p>' +
        '</div>';
      if (counter) counter.textContent = "0 items";
      if (stat) stat.textContent = "0";
      return;
    }

    grid.innerHTML = "";
    products.forEach(function (p, i) { grid.appendChild(renderCard(p, i)); });

    if (counter) counter.textContent = products.length + " item" + (products.length === 1 ? "" : "s");
    if (stat) stat.textContent = products.length;
  }

  function openOrderModal(product) {
    currentOrderProduct = product;
    var summary = document.getElementById("order-summary");
    if (summary) {
      summary.innerHTML =
        '<div class="thumb" ' + (product.imageUrl ? "style=\"background-image:url(\'' + escapeHtml(product.imageUrl) + '\')\"" : "") + '></div>' +
        '<div class="info">' +
          '<h4>' + escapeHtml(product.title || "Product") + '</h4>' +
          '<div class="price">' + formatPrice(product.price) + '</div>' +
        '</div>';
    }
    if (currentUser) {
      document.getElementById("cust-name").value = currentUser.displayName || "";
      document.getElementById("cust-email").value = currentUser.email || "";
    } else {
      var formEl = document.getElementById("order-form");
      if (formEl) formEl.reset();
    }
    selectedPaymentMethod = null;
    var det = document.getElementById("payment-details-section");
    var refSec = document.getElementById("payment-ref-section");
    if (det) det.style.display = "none";
    if (refSec) refSec.style.display = "none";
    appliedCoupon = null;
    appliedDiscount = 0;
    var couponInput = document.getElementById("coupon-input");
    if (couponInput) couponInput.value = "";
    renderCouponFeedback();
    renderPaymentMethods();
    updateCooldownUI();
    openModal("order-modal");
  }

  function openModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.add("active"); document.body.style.overflow = "hidden"; }
  }

  function updatePwStrength() {
    var pw = document.getElementById("auth-password").value || "";
    var wrap = document.getElementById("pw-strength");
    var bar = wrap ? wrap.querySelector(".pw-bar") : null;
    var label = document.getElementById("pw-label-text");
    if (!wrap || !bar || !label) return;
    if (activeAuthTab !== "signup") { wrap.classList.remove("visible"); return; }
    if (!pw) { wrap.classList.remove("visible"); return; }
    wrap.classList.add("visible");
    var score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    bar.classList.remove("weak", "medium", "strong");
    var text = "—", cls = "";
    if (score <= 2) { cls = "weak"; text = "Weak"; }
    else if (score <= 3) { cls = "medium"; text = "Medium"; }
    else { cls = "strong"; text = "Strong"; }
    bar.classList.add(cls);
    label.textContent = text;
  }

  function openAuthModal(tab) {
    tab = tab || "login";
    activeAuthTab = tab;
    var tabs = document.querySelectorAll(".auth-tab");
    tabs.forEach(function (t) { t.classList.toggle("active", t.dataset.authTab === tab); t.setAttribute("aria-selected", t.dataset.authTab === tab ? "true" : "false"); });
    document.getElementById("name-group").style.display = tab === "signup" ? "block" : "none";
    document.getElementById("auth-title").textContent = tab === "signup" ? "// Create Account" : "// Access Portal";
    document.getElementById("auth-btn-text").textContent = tab === "signup" ? "CREATE ACCOUNT" : "LOGIN";
    document.getElementById("auth-password").autocomplete = tab === "signup" ? "new-password" : "current-password";
    document.getElementById("auth-form").reset();
    document.getElementById("auth-error").style.display = "none";
    updatePwStrength();
    openModal("auth-modal");
  }

  function updateNavUser(user) {
    var navUser = document.getElementById("nav-user");
    var adminLink = document.getElementById("admin-link");
    if (!navUser) return;
    if (user) {
      var admin = isAdminEmail(user.email);
      if (adminLink) adminLink.style.display = "inline-flex";
      var initial = (user.displayName || user.email || "U").charAt(0).toUpperCase();
      navUser.innerHTML =
        '<div class="user-menu-wrap">' +
          '<div class="user-pill" id="user-pill" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">' +
            '<div class="user-avatar ' + (admin ? "admin" : "") + '">' + escapeHtml(initial) + '</div>' +
            '<span>' + escapeHtml(user.displayName || user.email.split("@")[0]) + '</span>' +
            '<span style="color:var(--text-muted)">▾</span>' +
          '</div>' +
          '<div class="user-dropdown" id="user-dropdown" role="menu">' +
            '<div class="label">' + (admin ? "⚡ ADMIN ACCOUNT" : "USER ACCOUNT") + '</div>' +
            '<div class="divider"></div>' +
            '<a href="account.html" role="menuitem">👤 My Account</a>' +
            (admin ? '<a href="admin.html" id="dd-admin" role="menuitem">⚡ Open Admin Panel</a>' : '') +
            '<a href="status.html" role="menuitem">📊 System Status</a>' +
            '<div class="divider"></div>' +
            '<a href="#" id="dd-logout" role="menuitem">⎋ Logout</a>' +
          '</div>' +
        '</div>';
      var pill = document.getElementById("user-pill");
      var dd = document.getElementById("user-dropdown");
      var toggleDropdown = function (e) { e.stopPropagation(); dd.classList.toggle("open"); pill.setAttribute("aria-expanded", dd.classList.contains("open") ? "true" : "false"); };
      pill.addEventListener("click", toggleDropdown);
      pill.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDropdown(e); } });
      var closeHandler = function () { dd.classList.remove("open"); pill.setAttribute("aria-expanded", "false"); };
      document.getElementById("dd-logout").addEventListener("click", async function (e) {
        e.preventDefault();
        try { await auth.signOut(); showToast("Logged out", "success"); }
        catch (err) { showToast("Logout failed", "error"); }
      });
      document.addEventListener("click", closeHandler);
    } else {
      if (adminLink) adminLink.style.display = "none";
      navUser.innerHTML =
        '<a href="status.html" class="btn btn-ghost btn-sm" title="System Status" style="padding:8px 10px;">📊</a>' +
        '<button class="btn btn-ghost btn-sm" id="open-login-btn">LOGIN</button>' +
        '<button class="btn btn-primary btn-sm" id="open-signup-btn">SIGN UP</button>';
      var loginBtn = document.getElementById("open-login-btn");
      var signupBtn = document.getElementById("open-signup-btn");
      if (loginBtn) loginBtn.addEventListener("click", function () { openAuthModal("login"); });
      if (signupBtn) signupBtn.addEventListener("click", function () { openAuthModal("signup"); });
    }
  }

  async function handleAuth(e) {
    e.preventDefault();
    var lockMsg = isLoginLocked();
    if (lockMsg) { showToast(lockMsg, "error"); return; }

    var email = document.getElementById("auth-email").value.trim();
    var password = document.getElementById("auth-password").value;
    var displayName = document.getElementById("auth-name").value.trim();
    var errBox = document.getElementById("auth-error");
    var btnText = document.getElementById("auth-btn-text");
    errBox.style.display = "none";
    btnText.textContent = activeAuthTab === "signup" ? "CREATING..." : "LOGGING IN...";

    if (!validateEmail(email)) {
      errBox.textContent = "Please enter a valid email address";
      errBox.style.display = "block";
      btnText.textContent = activeAuthTab === "signup" ? "CREATE ACCOUNT" : "LOGIN";
      return;
    }
    if (password.length < 6) {
      errBox.textContent = "Password must be at least 6 characters";
      errBox.style.display = "block";
      btnText.textContent = activeAuthTab === "signup" ? "CREATE ACCOUNT" : "LOGIN";
      return;
    }
    if (activeAuthTab === "signup") {
      if (displayName && containsUrl(displayName)) {
        errBox.textContent = "Display name cannot contain URLs";
        errBox.style.display = "block";
        btnText.textContent = activeAuthTab === "signup" ? "CREATE ACCOUNT" : "LOGIN";
        return;
      }
    }

    try {
      if (activeAuthTab === "signup") {
        var cred = await auth.createUserWithEmailAndPassword(email, password);
        if (displayName) await cred.user.updateProfile({ displayName: displayName });
        await saveFingerprintForUser(cred.user);
        showToast("Account created successfully", "success", "WELCOME");
      } else {
        await auth.signInWithEmailAndPassword(email, password);
        recordLoginAttempt(true);
        showToast("Logged in", "success");
      }
      closeModals();
      document.getElementById("auth-form").reset();
    } catch (err) {
      if (activeAuthTab === "login") recordLoginAttempt(false);
      errBox.textContent = friendlyAuthError(err.code);
      errBox.style.display = "block";
    } finally {
      btnText.textContent = activeAuthTab === "signup" ? "CREATE ACCOUNT" : "LOGIN";
    }
  }

  function friendlyAuthError(code) {
    var map = {
      "auth/invalid-email": "Invalid email format",
      "auth/user-not-found": "No account found with this email",
      "auth/wrong-password": "Incorrect password",
      "auth/invalid-credential": "Invalid email or password",
      "auth/email-already-in-use": "An account with this email already exists",
      "auth/weak-password": "Password must be at least 6 characters",
      "auth/too-many-requests": "Too many attempts. Try again later.",
      "auth/network-request-failed": "Network error. Check your connection.",
      "auth/user-disabled": "This account has been disabled."
    };
    return map[code] || "Authentication failed. Please try again.";
  }

  function getCooldownRemaining() {
    try {
      var fp = currentFingerprint || "anon";
      var key = "cy_last_order_" + fp;
      var last = parseInt(localStorage.getItem(key) || "0", 10);
      if (!last) return 0;
      var remaining = (SECURITY.ORDER_COOLDOWN_MS || 60000) - (Date.now() - last);
      return remaining > 0 ? remaining : 0;
    } catch (e) { return 0; }
  }

  function setCooldown() {
    try {
      var fp = currentFingerprint || "anon";
      var key = "cy_last_order_" + fp;
      localStorage.setItem(key, String(Date.now()));
    } catch (e) { /* */ }
  }

  function checkOrderCooldown() {
    var remaining = getCooldownRemaining();
    if (remaining > 0) {
      var secs = Math.ceil(remaining / 1000);
      return "Please wait " + secs + "s before placing another order";
    }
    return null;
  }

  function updateCooldownUI() {
    var submitBtn = document.getElementById("order-submit-btn");
    if (!submitBtn) return;
    var remaining = getCooldownRemaining();
    if (remaining > 0) {
      submitBtn.disabled = true;
      var secs = Math.ceil(remaining / 1000);
      submitBtn.textContent = "WAIT " + secs + "s";
      if (!window._cooldownTimer) {
        window._cooldownTimer = setInterval(function () {
          var r = getCooldownRemaining();
          if (r > 0) {
            submitBtn.textContent = "WAIT " + Math.ceil(r / 1000) + "s";
          } else {
            submitBtn.disabled = false;
            submitBtn.textContent = "SUBMIT ORDER";
            clearInterval(window._cooldownTimer);
            window._cooldownTimer = null;
          }
        }, 1000);
      }
    } else {
      submitBtn.disabled = false;
      submitBtn.textContent = "SUBMIT ORDER";
    }
  }

  async function submitOrder(e) {
    e.preventDefault();
    if (!currentOrderProduct) return;

    var honeypot = document.getElementById("website");
    if (honeypot && honeypot.value) {
      closeModals();
      return;
    }

    var cd = checkOrderCooldown();
    if (cd) { showToast(cd, "error"); updateCooldownUI(); return; }

    var submitBtn = document.getElementById("order-submit-btn");
    var errBox = document.getElementById("order-error");
    errBox.style.display = "none";
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-spinner"></span> GENERATING INVOICE...';

    var name = sanitizeText(document.getElementById("cust-name").value);
    var phone = sanitizeText(document.getElementById("cust-phone").value);
    var email = document.getElementById("cust-email").value.trim();
    var address = sanitizeText(document.getElementById("cust-address").value);
    var notes = sanitizeText(document.getElementById("cust-notes").value);

    if (!name || !phone || !email) {
      errBox.textContent = "Please fill in all required fields";
      errBox.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "SUBMIT ORDER";
      return;
    }
    if (!validateEmail(email)) {
      errBox.textContent = "Invalid email format";
      errBox.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "SUBMIT ORDER";
      return;
    }
    if (!validatePhone(phone)) {
      errBox.textContent = "Invalid phone number (6-20 digits)";
      errBox.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "SUBMIT ORDER";
      return;
    }
    if ((name + " " + notes + " " + address).length > 0 && containsUrl(name + " " + notes + " " + address)) {
      errBox.textContent = "Fields cannot contain URLs";
      errBox.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "SUBMIT ORDER";
      return;
    }
    if (!selectedPaymentMethod) {
      errBox.textContent = "Please select a payment method";
      errBox.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "SUBMIT ORDER";
      return;
    }
    var paymentRef = sanitizeText(document.getElementById("payment-ref").value);
    if (paymentRef && paymentRef.length < 3) {
      errBox.textContent = "Transaction reference too short (min 3 chars, or leave blank)";
      errBox.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "SUBMIT ORDER";
      return;
    }

    var invoiceId = (window.SynaxInvoice && window.SynaxInvoice.generateId) ? window.SynaxInvoice.generateId() : ("INV-" + Date.now());
    var productCategory = (currentOrderProduct && currentOrderProduct.category) ? currentOrderProduct.category : null;

    var data = {
      productId: currentOrderProduct.id,
      productTitle: currentOrderProduct.title || "Untitled",
      productPrice: currentOrderProduct.price || 0,
      productCategory: productCategory,
      productImage: currentOrderProduct.imageUrl || null,
      customerName: name,
      customerPhone: phone,
      customerEmail: email,
      customerAddress: address || null,
      notes: notes || null,
      status: "pending",
      invoiceId: invoiceId,
      paymentMethod: {
        id: selectedPaymentMethod.id,
        name: selectedPaymentMethod.name,
        type: selectedPaymentMethod.type || "mobile_wallet",
        icon: selectedPaymentMethod.icon || "💰",
        accountNumber: selectedPaymentMethod.accountNumber || "",
        accountName: selectedPaymentMethod.accountName || ""
      },
      paymentRef: paymentRef || null,
      coupon: appliedCoupon ? {
        code: appliedCoupon.code,
        type: appliedCoupon.type,
        value: Number(appliedCoupon.value) || 0,
        description: appliedCoupon.description || ""
      } : null,
      discountAmount: appliedDiscount > 0 ? appliedDiscount : 0,
      originalPrice: Number(currentOrderProduct.price) || 0,
      finalTotal: appliedDiscount > 0
        ? Math.max(0, (Number(currentOrderProduct.price) || 0) - appliedDiscount)
        : (Number(currentOrderProduct.price) || 0),
      userId: currentUser ? currentUser.uid : null,
      userFingerprint: currentFingerprint || null,
      userAgent: navigator.userAgent.slice(0, 200),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
      var t0 = Date.now();
      var invoice = (window.SynaxInvoice && window.SynaxInvoice.generate)
        ? window.SynaxInvoice.generate({ id: "PREVIEW", ...data, createdAt: new Date() })
        : null;
      var minDelay = 700;
      var elapsed = Date.now() - t0;
      if (elapsed < minDelay) await new Promise(function (r) { setTimeout(r, minDelay - elapsed); });

      var ref = await db.collection(COLLECTIONS.ORDERS).add(data);

      if (appliedCoupon && appliedCoupon.id) {
        try {
          await db.runTransaction(function (tx) {
            var couponRef = db.collection(COLLECTIONS.COUPONS).doc(appliedCoupon.id);
            return tx.get(couponRef).then(function (snap) {
              if (!snap.exists) return;
              var cd = snap.data();
              if (cd.maxUses) {
                var u = Number(cd.usedCount) || 0;
                if (u >= Number(cd.maxUses)) return;
              }
              tx.update(couponRef, {
                usedCount: firebase.firestore.FieldValue.increment(1),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
              });
            });
          });
        } catch (e) { console.warn("coupon usedCount increment failed:", e); }
      }

      if (invoice) {
        invoice.summary.orderId = ref.id;
        var regenerated = (window.SynaxInvoice && window.SynaxInvoice.generate)
          ? window.SynaxInvoice.generate({ id: ref.id, ...data, createdAt: new Date() })
          : null;
        if (regenerated) {
          window.SynaxInvoice.download(regenerated);
          invoice = regenerated;
        }
      }

      setCooldown();
      var orderWithId = { id: ref.id, ...data, invoiceId: invoiceId };

      try { await loadTelegramConfig(); } catch (e) {}

      sendTelegramNotification(orderWithId).catch(function (e) { console.warn("Telegram failed:", e); });
      sendTelegramInvoiceSummary(orderWithId, invoice).catch(function (e) { console.warn("Telegram summary failed:", e); });
      deliverInvoiceViaTelegram(orderWithId, invoice).then(function (res) {
        if (window.__refreshInvoiceToast) window.__refreshInvoiceToast(res && res.method, res && res.url);
      }).catch(function (e) { console.warn("Telegram PDF delivery failed:", e); });

      showInvoiceToast(ref.id, invoice, name);

      document.getElementById("order-form").reset();
      closeModals();
    } catch (err) {
      errBox.textContent = "Failed to submit: " + (err.message || "Unknown error");
      errBox.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "SUBMIT ORDER";
    }
  }

  async function loadTelegramConfig() {
    try {
      var doc = await db.collection(COLLECTIONS.CONFIG).doc("telegram").get();
      var data = doc.exists ? doc.data() : null;
      var defaults = window.TELEGRAM_DEFAULTS || {};
      if (data && data.botToken && data.chatId && data.enabled !== false) {
        telegramConfig = data;
      } else if (defaults.botToken && defaults.chatId) {
        telegramConfig = {
          botToken: defaults.botToken,
          chatId: defaults.chatId,
          enabled: true,
          alertsEnabled: true
        };
        console.log("[SynaxMatrix] Telegram config missing/disabled — using defaults");
      } else {
        telegramConfig = data || null;
      }
    } catch (e) { telegramConfig = null; }
  }

  async function sendTelegramNotification(order) {
    if (!telegramConfig || !telegramConfig.botToken || !telegramConfig.chatId) return;
    if (telegramConfig.enabled === false) return;
    var pm = order.paymentMethod || {};
    var priceStr = formatPrice(order.productPrice);
    var html =
      "🛒 <b>NEW ORDER RECEIVED</b>\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "📦 <b>Order</b>\n" +
      "  • ID: <code>" + escapeHtml(order.id || "—") + "</code>\n" +
      "  • Invoice: <code>" + escapeHtml(order.invoiceId || "—") + "</code>\n" +
      "  • Date: " + escapeHtml(new Date().toLocaleString()) + "\n\n" +
      "👤 <b>Customer</b>\n" +
      "  • Name: " + escapeHtml(order.customerName || "—") + "\n" +
      "  • Phone: <code>" + escapeHtml(order.customerPhone || "—") + "</code>\n" +
      "  • Email: " + escapeHtml(order.customerEmail || "—") + "\n" +
      (order.customerAddress ? "  • Address: " + escapeHtml(order.customerAddress) + "\n" : "") +
      (order.notes ? "  • Notes: " + escapeHtml(order.notes) + "\n" : "") + "\n" +
      "💼 <b>Service</b>\n" +
      "  • " + escapeHtml(order.productTitle || "—") + "\n" +
      (order.productCategory ? "  • Category: " + escapeHtml(order.productCategory) + "\n" : "") +
      "  • Price: <b>" + escapeHtml(priceStr) + "</b>" +
      (order.discountAmount && order.discountAmount > 0
        ? "\n  • Coupon: <code>" + escapeHtml((order.coupon && order.coupon.code) || "—") + "</code> (-" + escapeHtml(formatPrice(order.discountAmount)) + ")\n  • Final: <b>" + escapeHtml(formatPrice(order.finalTotal || order.productPrice)) + "</b>"
        : "") + "\n\n" +
      "💳 <b>Payment Method</b>\n" +
      "  • " + escapeHtml((pm.icon || "💰") + " " + (pm.name || "—")) + "\n" +
      (pm.accountNumber ? "  • Account: <code>" + escapeHtml(pm.accountNumber) + "</code>\n" : "") +
      (pm.accountName ? "  • Name: " + escapeHtml(pm.accountName) + "\n" : "") +
      (order.paymentRef ? "  • TXN Ref: <code>" + escapeHtml(order.paymentRef) + "</code>\n" : "  • TXN Ref: <i>not paid yet — contact customer</i>\n") + "\n" +
      "📌 <b>Status:</b> <i>Pending Contact</i>\n" +
      "━━━━━━━━━━━━━━━━━━━━";
    var url = "https://api.telegram.org/bot" + telegramConfig.botToken + "/sendMessage?chat_id=" + telegramConfig.chatId + "&parse_mode=HTML&text=" + encodeURIComponent(html);
    try { await fetch(url, { mode: "no-cors" }); } catch (e) { /* telegram will still send */ }
  }

  async function sendTelegramInvoiceSummary(order, invoice) {
    if (!telegramConfig || !telegramConfig.botToken || !telegramConfig.chatId) return;
    if (telegramConfig.enabled === false) return;
    if (!invoice || !invoice.summary) return;
    var s = invoice.summary;
    var html =
      "🧾 <b>INVOICE READY</b>\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "📄 <b>Invoice:</b> <code>" + escapeHtml(s.invoiceId || "—") + "</code>\n" +
      "📦 <b>Order:</b> <code>" + escapeHtml(s.orderId || "—") + "</code>\n" +
      "👤 <b>Customer:</b> " + escapeHtml(order.customerName || "—") + "\n" +
      "💼 <b>Service:</b> " + escapeHtml(s.product || "—") + "\n" +
      "💰 <b>Total:</b> <b>" + escapeHtml(s.price || "—") + "</b>" +
      (order.discountAmount && order.discountAmount > 0
        ? "\n🎟️ <b>Coupon:</b> <code>" + escapeHtml((order.coupon && order.coupon.code) || "—") + "</code> (-" + escapeHtml(formatPrice(order.discountAmount)) + ")\n💸 <b>Final:</b> <b>" + escapeHtml(formatPrice(order.finalTotal || order.productPrice)) + "</b>"
        : "") + "\n" +
      "💳 <b>Payment:</b> " + escapeHtml((order.paymentMethod && order.paymentMethod.name) || "—") + "\n" +
      (order.paymentRef ? "🔖 <b>TXN Ref:</b> <code>" + escapeHtml(order.paymentRef) + "</code>\n" : "⏳ <b>Payment:</b> <i>pending — not yet paid</i>\n") +
      "📅 <b>Date:</b> " + escapeHtml(s.date || "—") + "\n" +
      "━━━━━━━━━━━━━━━━━━━━";
    var url = "https://api.telegram.org/bot" + telegramConfig.botToken + "/sendMessage?chat_id=" + telegramConfig.chatId + "&parse_mode=HTML&text=" + encodeURIComponent(html);
    try { await fetch(url, { mode: "no-cors" }); } catch (e) { /* */ }
  }

  async function uploadToTempHost(blob, filename) {
    var cleanName = (filename || "invoice.pdf").replace(/[^\w.\-]/g, "_");
    var hosts = [
      {
        name: "litterbox.catbox.moe",
        url: "https://litterbox.catbox.moe/resources/internals/api.php",
        method: "POST",
        build: function (b, n) {
          var fd = new FormData();
          fd.append("reqtype", "fileupload");
          fd.append("time", "24h");
          fd.append("fileToUpload", b, n);
          return fd;
        },
        parse: function (t) { return { url: String(t || "").trim() }; }
      },
      {
        name: "file.io",
        url: "https://file.io",
        method: "POST",
        build: function (b, n) {
          var fd = new FormData();
          fd.append("file", b, n);
          fd.append("expires", "1d");
          return fd;
        },
        parse: function (t) {
          try {
            var j = JSON.parse(t);
            if (j && j.success && j.link) return { url: j.link };
            if (j && j.link) return { url: j.link };
            return null;
          } catch (e) { return null; }
        }
      },
      {
        name: "0x0.st",
        url: "https://0x0.st",
        method: "POST",
        build: function (b, n) {
          var fd = new FormData();
          fd.append("file", b, n);
          fd.append("expires", "24");
          return fd;
        },
        parse: function (t) { return { url: String(t || "").trim() }; }
      }
    ];
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      try {
        console.log("[SynaxMatrix] Trying upload host:", h.name);
        var res = await fetch(h.url, { method: h.method, body: h.build(blob, cleanName) });
        if (res.ok) {
          var text = await res.text();
          console.log("[SynaxMatrix] " + h.name + " response:", text.slice(0, 200));
          var parsed = h.parse(text);
          if (parsed && parsed.url && /^https?:\/\//.test(parsed.url)) {
            console.log("[SynaxMatrix] ✓ Uploaded PDF to " + h.name + ":", parsed.url);
            return { ok: true, url: parsed.url, host: h.name };
          }
          console.warn("[SynaxMatrix] " + h.name + " returned non-URL response");
        } else {
          console.warn("[SynaxMatrix] " + h.name + " HTTP " + res.status);
        }
      } catch (e) {
        console.warn("[SynaxMatrix] Upload to " + h.name + " failed:", e && e.message);
      }
    }
    return { ok: false };
  }

  async function sendTelegramText(chatId, html) {
    if (!telegramConfig || !telegramConfig.botToken) return { ok: false, reason: "missing-config" };
    if (telegramConfig.enabled === false) return { ok: false, reason: "telegram-disabled" };
    var cleanChat = String(chatId).replace(/[\s\-]/g, "");
    if (!/^\d{4,20}$/.test(cleanChat)) return { ok: false, reason: "bad-chatid" };
    try {
      var url = "https://api.telegram.org/bot" + telegramConfig.botToken + "/sendMessage?chat_id=" + cleanChat + "&parse_mode=HTML&text=" + encodeURIComponent(html);
      await fetch(url, { mode: "no-cors" });
      return { ok: true, method: "text" };
    } catch (e) {
      return { ok: false, reason: "network" };
    }
  }

  async function sendTelegramDocument(chatId, blob, filename, caption) {
    if (!telegramConfig || !telegramConfig.botToken || !chatId || !blob) return { ok: false, reason: "missing-config" };
    if (telegramConfig.enabled === false) return { ok: false, reason: "telegram-disabled" };
    if (typeof chatId === "string") chatId = chatId.replace(/[\s\-]/g, "");
    if (!/^\d{4,20}$/.test(String(chatId))) return { ok: false, reason: "bad-chatid" };

    var cleanName = (filename || "invoice.pdf").replace(/[^\w.\-]/g, "_");

    try {
      var up = await uploadToTempHost(blob, cleanName);
      if (up && up.ok) {
        var linkText =
          (caption ? caption + "\n\n" : "") +
          "━━━━━━━━━━━━━━━━━━━━\n" +
          "📄 <b>Invoice PDF:</b>\n" +
          "<a href=\"" + up.url + "\">⬇ Download Invoice (PDF)</a>\n" +
          "<i>Hosted on " + up.host + " · expires in 24h</i>";
        if (linkText.length > 4000) linkText = linkText.slice(0, 4000) + "...";
        var res = await sendTelegramText(chatId, linkText);
        if (res && res.ok) return { ok: true, method: "link-upload", url: up.url, host: up.host };
        return { ok: false, reason: "text-failed", url: up.url, host: up.host };
      }
    } catch (e) {
      console.warn("uploadToTempHost failed in sendTelegramDocument:", e && e.message);
    }

    try {
      var url = "https://api.telegram.org/bot" + telegramConfig.botToken + "/sendDocument";
      var fd = new FormData();
      fd.append("chat_id", String(chatId));
      fd.append("document", blob, cleanName);
      if (caption) {
        fd.append("caption", String(caption).slice(0, 1024));
        fd.append("parse_mode", "HTML");
      }
      var res2 = await fetch(url, { method: "POST", mode: "no-cors", body: fd });
      return { ok: true, method: "no-cors" };
    } catch (e2) {
      console.error("sendTelegramDocument all paths failed:", e2);
      return { ok: false, reason: "all-failed" };
    }
  }

  async function deliverInvoiceViaTelegram(order, invoice) {
    if (!invoice || !invoice.blob || !invoice.filename) return;
    if (!telegramConfig || !telegramConfig.botToken) { try { await loadTelegramConfig(); } catch (e) {} }
    if (!telegramConfig || !telegramConfig.botToken) {
      console.warn("✗ Telegram not configured (no bot token). Skipping PDF delivery.");
      return;
    }
    if (telegramConfig.enabled === false) {
      console.warn("✗ Telegram is DISABLED in config (admin → Telegram tab → uncheck 'Send notifications'). Skipping PDF delivery.");
      return;
    }

    var caption =
      "🧾 <b>Your SynaxMatrix Order</b>\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "📄 <b>Invoice:</b> <code>" + escapeHtml(invoice.summary.invoiceId || "—") + "</code>\n" +
      "📦 <b>Order:</b> <code>" + escapeHtml(order.id || "—") + "</code>\n" +
      "💼 <b>Service:</b> " + escapeHtml(order.productTitle || "—") + "\n" +
      "💰 <b>Total:</b> <b>" + escapeHtml(invoice.summary.price || "—") + "</b>" +
      (order.discountAmount && order.discountAmount > 0
        ? "\n🎟️ <b>Coupon:</b> <code>" + escapeHtml((order.coupon && order.coupon.code) || "—") + "</code> (-" + escapeHtml(formatPrice(order.discountAmount)) + ")\n💸 <b>Final:</b> <b>" + escapeHtml(formatPrice(order.finalTotal || order.productPrice)) + "</b>"
        : "") + "\n" +
      "💳 <b>Payment:</b> " + escapeHtml((order.paymentMethod && order.paymentMethod.name) || "—") + "\n" +
      (order.paymentRef ? "🔖 <b>Your TXN:</b> <code>" + escapeHtml(order.paymentRef) + "</code>\n" : "") +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "✅ <b>Thank you for your order!</b>\n" +
      "Our team will contact you shortly to confirm payment via your selected method. 🚀";

    if (currentUser) {
      try {
        var userDoc = await db.collection(COLLECTIONS.USERS).doc(currentUser.uid).get();
        var userData = userDoc.exists ? userDoc.data() : null;
        var userChatId = userData && userData.telegramChatId ? String(userData.telegramChatId) : null;
        if (userChatId) {
          var r = await sendTelegramDocument(userChatId, invoice.blob, invoice.filename, caption);
          if (r && r.ok) console.log("✓ Invoice PDF sent to user Telegram:", userChatId, "(" + r.method + (r.url ? " · " + r.url : "") + ")");
          else console.warn("✗ User PDF delivery failed:", r);
        }
      } catch (e) { console.warn("User chat id lookup failed:", e); }
    }

    var adminChatId = telegramConfig.chatId;
    if (adminChatId) {
      var adminCaption =
        "📥 <b>New Order — Invoice PDF</b>\n" +
        "━━━━━━━━━━━━━━━━━━━━\n" +
        "📦 <b>Order:</b> <code>" + escapeHtml(order.id || "—") + "</code>\n" +
        "📄 <b>Invoice:</b> <code>" + escapeHtml(invoice.summary.invoiceId || "—") + "</code>\n" +
        "👤 <b>Customer:</b> " + escapeHtml(order.customerName || "—") + " (<code>" + escapeHtml(order.customerEmail || "—") + "</code>)\n" +
        "📞 <b>Phone:</b> <code>" + escapeHtml(order.customerPhone || "—") + "</code>\n" +
        "💼 <b>Service:</b> " + escapeHtml(order.productTitle || "—") + "\n" +
        "💰 <b>Total:</b> <b>" + escapeHtml(invoice.summary.price || "—") + "</b>" +
        (order.discountAmount && order.discountAmount > 0
          ? "\n🎟️ <b>Coupon:</b> <code>" + escapeHtml((order.coupon && order.coupon.code) || "—") + "</code> (-" + escapeHtml(formatPrice(order.discountAmount)) + ")\n💸 <b>Final:</b> <b>" + escapeHtml(formatPrice(order.finalTotal || order.productPrice)) + "</b>"
          : "") + "\n" +
        "💳 <b>Payment:</b> " + escapeHtml((order.paymentMethod && order.paymentMethod.name) || "—") + "\n" +
        (order.paymentRef
          ? "🔖 <b>TXN Ref:</b> <code>" + escapeHtml(order.paymentRef) + "</code> (paid)\n"
          : "⏳ <b>TXN Ref:</b> <i>not provided — customer hasn't paid yet</i>\n") +
        "━━━━━━━━━━━━━━━━━━━━";
      var ar = await sendTelegramDocument(adminChatId, invoice.blob, invoice.filename, adminCaption);
      if (ar && ar.ok) {
        console.log("✓ Invoice PDF sent to admin Telegram (" + ar.method + (ar.url ? " · " + ar.url : "") + ")");
        return ar;
      } else {
        console.warn("✗ Admin PDF delivery failed:", ar);
        return ar;
      }
    }
    return null;
  }

  function showInvoiceToast(orderId, invoice, customerName) {
    var container = document.getElementById("toast-container");
    if (!container) return;
    var t = document.createElement("div");
    t.className = "toast success invoice-toast";
    var title = "ORDER #" + (orderId || "").slice(0, 8).toUpperCase();
    var invoiceId = invoice && invoice.summary ? invoice.summary.invoiceId : null;
    var tgSlotId = "tg-slot-" + (orderId || Date.now());
    t.innerHTML =
      (title ? '<div class="toast-title">' + escapeHtml(title) + '</div>' : "") +
      '<div class="toast-msg">Order placed · Invoice downloaded</div>' +
      (invoiceId ? '<div style="margin-top:8px; font-family: var(--font-mono); font-size: 0.75rem; color: var(--primary);">📄 ' + escapeHtml(invoiceId) + '.pdf</div>' : "") +
      '<div id="' + tgSlotId + '" style="margin-top:6px; font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono);">📡 Sending to Telegram...</div>' +
      (invoice && invoice.dataUrl ? '<a href="' + invoice.dataUrl + '" download="' + escapeHtml(invoice.filename) + '" style="display:inline-block; margin-top:10px; padding:6px 12px; background: rgba(0,240,255,0.15); border:1px solid var(--primary); border-radius:6px; color: var(--primary); font-size: 0.8rem; font-weight: 700; letter-spacing: 1px; text-decoration: none;">⬇ DOWNLOAD INVOICE</a>' : '');
    container.appendChild(t);
    window.__refreshInvoiceToast = function (method, url) {
      var slot = document.getElementById(tgSlotId);
      if (slot && slot.parentNode) {
        var icon = "📡";
        var txt = "PDF sent to Admin Telegram";
        if (method === "link-fallback") {
          icon = "🔗";
          txt = "PDF link sent to Admin Telegram";
          if (url) txt += ' · <a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" style="color:var(--primary); text-decoration: underline;">view here</a>';
        } else if (method === "no-cors") {
          icon = "📤";
          txt = "PDF uploaded to Admin Telegram (fire-and-forget)";
        }
        slot.innerHTML = icon + " " + txt + (currentUser ? ' · <span style="color:var(--accent);">check your Telegram</span>' : '');
      }
    };
    setTimeout(function () {
      t.style.opacity = "0";
      t.style.transform = "translateX(20px)";
      t.style.transition = "all 0.3s";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 10000);
  }

  async function sendTelegramAlert(subject, details) {
    if (SECURITY.ALERTS_ENABLED === false) return;
    try { if (!telegramConfig) await loadTelegramConfig(); } catch (e) { return; }
    if (!telegramConfig || !telegramConfig.botToken || !telegramConfig.chatId) return;
    if (telegramConfig.alertsEnabled === false) return;

    var lines = ["🚨 *" + subject + "*", ""];
    if (details) {
      Object.keys(details).forEach(function (k) {
        lines.push("• " + k + ": " + details[k]);
      });
    }
    lines.push("", "⏰ " + new Date().toLocaleString());

    var text = encodeURIComponent(lines.join("\n"));
    var url = "https://api.telegram.org/bot" + telegramConfig.botToken + "/sendMessage?chat_id=" + telegramConfig.chatId + "&parse_mode=Markdown&text=" + text;
    try { await fetch(url, { mode: "no-cors" }); } catch (e) { /* telegram will still send */ }
  }

  function attachEvents() {
    document.querySelectorAll("[data-close]").forEach(function (el) {
      el.addEventListener("click", closeModals);
    });
    document.querySelectorAll(".modal-overlay").forEach(function (m) {
      m.addEventListener("click", function (e) { if (e.target === m) closeModals(); });
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModals(); });

    document.querySelectorAll(".auth-tab").forEach(function (t) {
      t.addEventListener("click", function () { openAuthModal(t.dataset.authTab); });
    });
    document.getElementById("auth-form").addEventListener("submit", handleAuth);
    document.getElementById("order-form").addEventListener("submit", submitOrder);
    var pwInput = document.getElementById("auth-password");
    if (pwInput) pwInput.addEventListener("input", updatePwStrength);

    var loginBtn = document.getElementById("open-login-btn");
    var signupBtn = document.getElementById("open-signup-btn");
    if (loginBtn) loginBtn.addEventListener("click", function () { openAuthModal("login"); });
    if (signupBtn) signupBtn.addEventListener("click", function () { openAuthModal("signup"); });

    attachPaymentEvents();

    var toggle = document.getElementById("nav-toggle");
    var links = document.getElementById("nav-links");
    if (toggle && links) {
      toggle.addEventListener("click", function () {
        var open = links.classList.toggle("open");
        toggle.classList.toggle("open", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        document.body.style.overflow = open ? "hidden" : "";
      });
      links.querySelectorAll("a").forEach(function (a) {
        a.addEventListener("click", function () {
          links.classList.remove("open");
          toggle.classList.remove("open");
          toggle.setAttribute("aria-expanded", "false");
          document.body.style.overflow = "";
        });
      });
    }

    var btt = document.getElementById("back-to-top");
    if (btt) {
      window.addEventListener("scroll", function () {
        if (window.scrollY > 400) btt.classList.add("visible");
        else btt.classList.remove("visible");
      }, { passive: true });
      btt.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
    }
  }

  async function init() {
    attachEvents();
    var allowed = await enforceBan();
    if (!allowed) return;

    var inMaintenance = await checkMaintenance();
    if (inMaintenance) return;

    auth.onAuthStateChanged(function (user) {
      currentUser = user;
      updateNavUser(user);
      if (user) {
        startPresence(user);
        saveFingerprintForUser(user);
      } else {
        stopPresence();
      }
    });

    loadTelegramConfig();
    startAdminListListener();
    startPaymentMethodsListener();
    logVisit();

    try {
      db.collection(COLLECTIONS.PRODUCTS)
        .onSnapshot(function (snap) {
          var products = [];
          snap.forEach(function (doc) { products.push({ id: doc.id, ...doc.data() }); });
          products.sort(function (a, b) {
            var aT = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
            var bT = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
            return bT - aT;
          });
          renderProducts(products);
        }, function (err) {
          console.error("Snapshot error", err);
          var grid = document.getElementById("product-grid");
          if (grid) {
            grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">' +
              '<div class="icon">&#9888;</div>' +
              '<h3 style="color:var(--danger); font-family:var(--font-display);">CONNECTION FAILED</h3>' +
              '<p>Unable to reach the database. Verify firebase-config.js and security rules.</p>' +
            '</div>';
          }
        });
    } catch (e) { console.error("Init error", e); }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
