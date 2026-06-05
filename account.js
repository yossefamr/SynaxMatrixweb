(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return document.querySelectorAll(sel); };

  var currentUser = null;
  var currentUserData = null;
  var ordersListener = null;
  var heartbeatInterval = null;
  var adminEmailsCache = [];
  var currentFingerprint = null;
  var VISIT_LOGGED_KEY = "cy_visit_logged_";
  var MAINTENANCE_CACHE_KEY = "cy_maint";
  var MAINTENANCE_CACHE_TTL = 30000;

  function isAdminEmail(email) {
    if (!email) return false;
    var lower = email.toLowerCase();
    if (lower === OWNER_EMAIL.toLowerCase()) return true;
    return adminEmailsCache.some(function (e) { return e.toLowerCase() === lower; });
  }

  function showToast(msg, type, title) {
    type = type || "info";
    title = title || "";
    var container = $("#toast-container");
    if (!container) return;
    var t = document.createElement("div");
    t.className = "toast " + type;
    t.innerHTML = (title ? '<div class="toast-title">' + escapeHtml(title) + '</div>' : "") +
                  '<div class="toast-msg">' + escapeHtml(String(msg)) + '</div>';
    container.appendChild(t);
    setTimeout(function () {
      t.style.opacity = "0";
      t.style.transition = "all 0.3s";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 4000);
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatPrice(n) { return CURRENCY.format(n); }

  function formatDate(ts) {
    if (!ts) return "—";
    var d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString();
  }

  function timeAgo(ts) {
    if (!ts) return "Never";
    var d = ts.toDate ? ts.toDate() : new Date(ts);
    var diff = Date.now() - d.getTime();
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + " min ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " hr ago";
    if (diff < 604800000) return Math.floor(diff / 86400000) + " days ago";
    return d.toLocaleDateString();
  }

  function updateNavUser(user) {
    var navUser = $("#nav-user");
    var adminLink = $("#admin-link");
    if (!navUser) return;
    if (user) {
      var isAdmin = isAdminEmail(user.email);
      if (adminLink) adminLink.style.display = isAdmin ? "inline-flex" : "none";
      var initial = (user.displayName || user.email || "U").charAt(0).toUpperCase();
      navUser.innerHTML =
        '<div class="user-menu-wrap">' +
          '<div class="user-pill" id="user-pill" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">' +
            '<div class="user-avatar ' + (isAdmin ? "admin" : "") + '">' + escapeHtml(initial) + '</div>' +
            '<span>' + escapeHtml(user.displayName || user.email.split("@")[0]) + '</span>' +
            '<span style="color:var(--text-muted)">▾</span>' +
          '</div>' +
          '<div class="user-dropdown" id="user-dropdown" role="menu">' +
            '<div class="label">' + (isAdmin ? "⚡ ADMIN ACCOUNT" : "USER ACCOUNT") + '</div>' +
            '<div class="divider"></div>' +
            '<a href="account.html" role="menuitem">👤 My Account</a>' +
            (isAdmin ? '<a href="admin.html" id="dd-admin" role="menuitem">⚡ Admin Panel</a>' : '') +
            '<a href="index.html" role="menuitem">🏠 Store</a>' +
            '<a href="status.html" role="menuitem">📊 System Status</a>' +
            '<div class="divider"></div>' +
            '<a href="#" id="dd-logout" role="menuitem">⎋ Logout</a>' +
          '</div>' +
        '</div>';
      var pill = document.getElementById("user-pill");
      var dd = document.getElementById("user-dropdown");
      var toggleDd = function (e) { e.stopPropagation(); dd.classList.toggle("open"); pill.setAttribute("aria-expanded", dd.classList.contains("open") ? "true" : "false"); };
      pill.addEventListener("click", toggleDd);
      pill.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDd(e); } });
      document.getElementById("dd-logout").addEventListener("click", async function (e) {
        e.preventDefault();
        try { await auth.signOut(); window.location.href = "index.html"; }
        catch (err) { showToast("Logout failed", "error"); }
      });
      document.addEventListener("click", function () { dd.classList.remove("open"); pill.setAttribute("aria-expanded", "false"); });
    } else {
      if (adminLink) adminLink.style.display = "none";
      navUser.innerHTML =
        '<a href="status.html" class="btn btn-ghost btn-sm" title="System Status" style="padding:8px 10px;">📊</a>' +
        '<a href="index.html" class="btn btn-primary btn-sm">SIGN IN</a>';
    }
  }

  async function getFingerprint() {
    if (currentFingerprint) return currentFingerprint;
    try {
      var cached = sessionStorage.getItem("cy_fp");
      var ts = parseInt(sessionStorage.getItem("cy_fp_ts") || "0", 10);
      if (cached && Date.now() - ts < 3600000) { currentFingerprint = cached; return cached; }
    } catch (e) {}
    if (typeof FingerprintJS === "undefined") {
      var hash = 0;
      var seed = navigator.userAgent + "|" + screen.width + "x" + screen.height + "|" + navigator.language + "|" + (navigator.hardwareConcurrency || 0);
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
      sessionStorage.setItem("cy_fp", currentFingerprint);
      sessionStorage.setItem("cy_fp_ts", String(Date.now()));
    } catch (e) {}
    return currentFingerprint;
  }

  async function logVisit() {
    if (typeof db === "undefined") return;
    try {
      var page = window.location.pathname.split("/").pop() || "account.html";
      var flagKey = VISIT_LOGGED_KEY + page;
      var last = parseInt(sessionStorage.getItem(flagKey) || "0", 10);
      if (last && Date.now() - last < 10000) return;
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
    if (path.indexOf("maintenance.html") !== -1 || path.indexOf("admin.html") !== -1) return false;
    try {
      var cached = sessionStorage.getItem(MAINTENANCE_CACHE_KEY);
      if (cached) {
        try {
          var parsed = JSON.parse(cached);
          if (parsed && Date.now() - parsed.ts < MAINTENANCE_CACHE_TTL) {
            if (parsed.enabled) { window.location.replace("maintenance.html"); return true; }
            return false;
          }
        } catch (e) { /* */ }
      }
      var doc = await db.collection(COLLECTIONS.CONFIG).doc("maintenance").get();
      var enabled = doc.exists && doc.data().enabled === true;
      try { sessionStorage.setItem(MAINTENANCE_CACHE_KEY, JSON.stringify({ enabled: enabled, ts: Date.now() })); } catch (e) {}
      if (enabled) { window.location.replace("maintenance.html"); return true; }
    } catch (e) { /* fail open */ }
    return false;
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

  function startPresence(user) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    var update = function () {
      db.collection(COLLECTIONS.USERS).doc(user.uid).update({
        lastSeen: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(function () {});
    };
    update();
    heartbeatInterval = setInterval(update, 60000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) update();
    });
  }

  function stopPresence() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  }

  function loadUserData(user) {
    db.collection(COLLECTIONS.USERS).doc(user.uid).onSnapshot(function (snap) {
      if (snap.exists) {
        currentUserData = snap.data();
        renderProfile(currentUserData);
      }
    }, function (err) { console.warn("User doc load error:", err); });
  }

  function renderProfile(data) {
    var name = (data && data.displayName) || (currentUser.displayName || currentUser.email.split("@")[0]);
    var initial = name.charAt(0).toUpperCase();
    var avatar = $("#profile-avatar");
    if (avatar) avatar.textContent = initial;
    var nameInput = $("#profile-name");
    if (nameInput) nameInput.value = name;
    var emailInput = $("#profile-email");
    if (emailInput) emailInput.value = currentUser.email;
    var uidInput = $("#profile-uid");
    if (uidInput) uidInput.value = currentUser.uid;
    var joinedInput = $("#profile-joined");
    if (joinedInput) joinedInput.value = data && data.createdAt ? formatDate(data.createdAt) : "—";

    if (data && data.fingerprint) {
      var fpEl = $("#device-fp");
      if (fpEl) fpEl.textContent = data.fingerprint;
    }
  }

  function startOrdersListener(user) {
    if (ordersListener) ordersListener();
    ordersListener = db.collection(COLLECTIONS.ORDERS)
      .where("userId", "==", user.uid)
      .onSnapshot(function (snap) {
        var orders = [];
        snap.forEach(function (d) { orders.push({ id: d.id, ...d.data() }); });
        orders.sort(function (a, b) {
          var aT = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
          var bT = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
          return bT - aT;
        });
        renderOrders(orders);
        updateOrderStats(orders);
      }, function (err) {
        console.error("Orders error:", err);
        var container = $("#user-orders");
        if (container) {
          container.innerHTML = '<div class="empty-state">' +
            '<div class="icon">&#9888;</div>' +
            '<h3 style="color:var(--danger);">Could not load orders</h3>' +
            '<p>' + escapeHtml(err.message) + '</p>' +
          '</div>';
        }
      });
  }

  function updateOrderStats(orders) {
    var total = orders.length;
    var pending = orders.filter(function (o) { return (o.status || "pending") === "pending"; }).length;
    var completed = orders.filter(function (o) { return o.status === "completed"; }).length;
    $("#stat-total").textContent = total;
    $("#stat-pending").textContent = pending;
    $("#stat-completed").textContent = completed;
  }

  function renderOrders(orders) {
    var container = $("#user-orders");
    if (!container) return;
    if (!orders.length) {
      container.innerHTML =
        '<div class="empty-state scanline-frame" style="position: relative; padding: 60px 20px;">' +
          '<span class="corner-clip tl"></span><span class="corner-clip tr"></span>' +
          '<span class="corner-clip bl"></span><span class="corner-clip br"></span>' +
          '<div class="icon">&#128722;</div>' +
          '<h3 style="color:var(--text); font-family:var(--font-display); letter-spacing:2px; margin-bottom: 8px;">NO ORDERS YET</h3>' +
          '<p>Browse the catalog and place your first order.</p>' +
          '<div style="margin-top: 20px;">' +
            '<a href="index.html#products" class="btn btn-primary">BROWSE CATALOG</a>' +
          '</div>' +
        '</div>';
      return;
    }
    container.innerHTML = "";
    orders.forEach(function (o, i) {
      var card = document.createElement("div");
      card.className = "order-card fade-in";
      card.style.animationDelay = (i * 30) + "ms";
      var status = o.status || "pending";
      var statusInfo = {
        pending: { label: "Awaiting Contact", color: "var(--warn)", icon: "⏳" },
        contacted: { label: "We've Reached Out", color: "var(--primary)", icon: "📞" },
        completed: { label: "Completed", color: "var(--accent)", icon: "✓" },
        cancelled: { label: "Cancelled", color: "var(--danger)", icon: "✕" }
      }[status] || { label: status, color: "var(--text)", icon: "" };
      card.innerHTML =
        '<div class="order-card-header">' +
          '<div>' +
            '<div style="font-family: var(--font-display); font-size: 1.05rem; letter-spacing: 1px; margin-bottom: 4px;">' + escapeHtml(o.productTitle) + '</div>' +
            '<div class="order-id">ORDER #' + escapeHtml(o.id.slice(0, 12).toUpperCase()) + '</div>' +
          '</div>' +
          '<div style="text-align: right;">' +
            '<div class="order-status ' + escapeHtml(status) + '" style="display: inline-flex; align-items: center; gap: 6px;">' +
              '<span>' + statusInfo.icon + '</span> ' + statusInfo.label +
            '</div>' +
            '<div style="color: var(--primary); font-family: var(--font-display); font-weight: 800; margin-top: 6px; font-size: 1.1rem;">' + formatPrice(o.productPrice) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="order-card-body">' +
          (o.notes ? '<div class="order-field" style="grid-column: 1/-1"><div class="label">Your Notes</div><div class="value">' + escapeHtml(o.notes) + '</div></div>' : "") +
          '<div class="order-field"><div class="label">Placed</div><div class="value">' + formatDate(o.createdAt) + ' <span style="color:var(--text-muted); font-size:0.8rem;">(' + escapeHtml(timeAgo(o.createdAt)) + ')</span></div></div>' +
        '</div>';
      container.appendChild(card);
    });
  }

  async function saveProfile(e) {
    e.preventDefault();
    var name = $("#profile-name").value.trim();
    if (!name) { showToast("Name cannot be empty", "error"); return; }
    if (name.length > 50) { showToast("Name too long (max 50 chars)", "error"); return; }
    try {
      await currentUser.updateProfile({ displayName: name });
      await db.collection(COLLECTIONS.USERS).doc(currentUser.uid).update({ displayName: name });
      showToast("Profile updated", "success");
      updateNavUser(currentUser);
    } catch (err) { showToast("Update failed: " + err.message, "error"); }
  }

  async function sendPasswordReset() {
    try {
      await auth.sendPasswordResetEmail(currentUser.email);
      showToast("Reset link sent to " + currentUser.email, "success", "CHECK INBOX");
    } catch (err) { showToast("Failed: " + err.message, "error"); }
  }

  function startAdminListListener() {
    db.collection(COLLECTIONS.CONFIG).doc("admins").onSnapshot(function (snap) {
      adminEmailsCache = snap.exists ? (snap.data().emails || []) : [];
      if (currentUser) updateNavUser(currentUser);
    }, function () {});
  }

  function attachNavToggle() {
    var toggle = document.getElementById("nav-toggle");
    var links = document.getElementById("nav-links");
    if (!toggle || !links) return;
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

  function attachBackToTop() {
    var btt = document.getElementById("back-to-top");
    if (!btt) return;
    window.addEventListener("scroll", function () {
      if (window.scrollY > 400) btt.classList.add("visible");
      else btt.classList.remove("visible");
    }, { passive: true });
    btt.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
  }

  function init() {
    attachNavToggle();
    attachBackToTop();

    checkMaintenance().then(function (blocked) {
      if (blocked) return;
      logVisit();

      auth.onAuthStateChanged(async function (user) {
        currentUser = user;
        if (user) {
          $("#auth-required").style.display = "none";
          $("#account-content").style.display = "block";
          updateNavUser(user);
          renderProfile({});
          loadUserData(user);
          startOrdersListener(user);
          startPresence(user);
          saveFingerprintForUser(user);
          var fp = await getFingerprint();
          var fpEl = $("#device-fp");
          if (fpEl) fpEl.textContent = fp;
        } else {
          $("#auth-required").style.display = "block";
          $("#account-content").style.display = "none";
          updateNavUser(null);
          stopPresence();
        }
      });
    });

    startAdminListListener();

    var profileForm = $("#profile-form");
    if (profileForm) profileForm.addEventListener("submit", saveProfile);
    var resetBtn = $("#reset-pw-btn");
    if (resetBtn) resetBtn.addEventListener("click", sendPasswordReset);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
