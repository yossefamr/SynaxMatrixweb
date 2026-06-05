(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return document.querySelectorAll(sel); };

  var currentUser = null;
  var currentUserIsAdmin = false;
  var productsListener = null;
  var blocksListener = null;
  var ordersListener = null;
  var usersListener = null;
  var adminListListener = null;
  var currentOrderFilter = "all";
  var currentOrders = [];
  var adminEmailsCache = [];
  var loginAttempts = 0;

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
    if (!ts) return "—";
    var d = ts.toDate ? ts.toDate() : new Date(ts);
    var diff = Date.now() - d.getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    if (diff < 604800000) return Math.floor(diff / 86400000) + "d ago";
    return d.toLocaleDateString();
  }

  function openModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.add("active"); document.body.style.overflow = "hidden"; }
  }
  function closeModals() {
    $$(".modal-overlay.active").forEach(function (m) { m.classList.remove("active"); });
    document.body.style.overflow = "";
  }

  function setAuthUI(user) {
    if (user && currentUserIsAdmin) {
      $("#login-view").style.display = "none";
      $("#denied-view").style.display = "none";
      $("#dashboard-view").style.display = "grid";
      var email = user.email || "operator";
      $("#user-email").textContent = email;
      $("#user-avatar").textContent = email.charAt(0).toUpperCase();
      startListeners();
      logAdminEvent("login", user.email);
    } else if (user) {
      $("#login-view").style.display = "none";
      $("#dashboard-view").style.display = "none";
      $("#denied-view").style.display = "flex";
      $("#denied-email").textContent = user.email || "";
      stopListeners();
      logAdminEvent("denied_attempt", user.email);
    } else {
      $("#login-view").style.display = "flex";
      $("#dashboard-view").style.display = "none";
      $("#denied-view").style.display = "none";
      stopListeners();
    }
  }

  function logAdminEvent(action, email) {
    try {
      db.collection("config").doc("auditLog").collection("entries").add({
        action: action,
        email: email || (currentUser && currentUser.email) || "unknown",
        ua: navigator.userAgent.slice(0, 200),
        ts: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(function () { /* best effort */ });
    } catch (e) { /* */ }
  }

  async function ensureAdminDoc() {
    if (!currentUser) return;
    try {
      var ref = db.collection(COLLECTIONS.CONFIG).doc("admins");
      var snap = await ref.get();
      if (!snap.exists) {
        await ref.set({
          emails: [currentUser.email.toLowerCase()],
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: currentUser.email
        });
      }
    } catch (e) { console.warn("Could not init admin doc:", e.message); }
  }

  function startAdminListListener() {
    if (adminListListener) adminListListener();
    adminListListener = db.collection(COLLECTIONS.CONFIG).doc("admins").onSnapshot(function (snap) {
      adminEmailsCache = snap.exists ? (snap.data().emails || []) : [];
      if (currentUser) {
        currentUserIsAdmin = isAdminEmail(currentUser.email);
        setAuthUI(currentUser);
      }
    }, function (err) { console.warn("Admin list listener error:", err); });
  }

  function startListeners() {
    stopListeners();

    productsListener = db.collection(COLLECTIONS.PRODUCTS)
      .onSnapshot(function (snap) {
        var products = [];
        snap.forEach(function (d) { products.push({ id: d.id, ...d.data() }); });
        products.sort(function (a, b) {
          var aT = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
          var bT = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
          return bT - aT;
        });
        renderAdminProducts(products);
        updateStats(products);
      }, function (err) {
        console.error("Products listener error:", err);
        showToast("Failed to load products: " + err.message, "error", "ERROR");
      });

    blocksListener = db.collection(COLLECTIONS.BLOCKED)
      .onSnapshot(function (snap) {
        var blocks = [];
        snap.forEach(function (d) { blocks.push({ id: d.id, ...d.data() }); });
        blocks.sort(function (a, b) {
          var aT = a.blockedAt && a.blockedAt.toDate ? a.blockedAt.toDate().getTime() : 0;
          var bT = b.blockedAt && b.blockedAt.toDate ? b.blockedAt.toDate().getTime() : 0;
          return bT - aT;
        });
        renderBlocks(blocks);
        var countEl = $("#stat-blocks");
        if (countEl) countEl.textContent = blocks.length;
      }, function (err) { console.error("Blocks listener error:", err); });

    ordersListener = db.collection(COLLECTIONS.ORDERS)
      .onSnapshot(function (snap) {
        var orders = [];
        snap.forEach(function (d) { orders.push({ id: d.id, ...d.data() }); });
        orders.sort(function (a, b) {
          var aT = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
          var bT = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
          return bT - aT;
        });
        setOrders(orders);
        var pending = orders.filter(function (o) { return (o.status || "pending") === "pending"; }).length;
        var badge = $("#orders-badge");
        if (badge) {
          if (pending > 0) { badge.style.display = "inline-block"; badge.textContent = pending; }
          else { badge.style.display = "none"; }
        }
      }, function (err) {
        console.error("Orders listener error:", err);
        showToast("Failed to load orders: " + err.message, "error", "ERROR");
      });

    usersListener = db.collection(COLLECTIONS.USERS)
      .onSnapshot(function (snap) {
        var users = [];
        snap.forEach(function (d) { users.push({ id: d.id, ...d.data() }); });
        users.sort(function (a, b) {
          var aT = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
          var bT = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
          return bT - aT;
        });
        renderUsers(users);
        updateUserStats(users);
      }, function (err) { console.error("Users listener error:", err); });
  }

  function stopListeners() {
    if (productsListener) { productsListener(); productsListener = null; }
    if (blocksListener) { blocksListener(); blocksListener = null; }
    if (ordersListener) { ordersListener(); ordersListener = null; }
    if (usersListener) { usersListener(); usersListener = null; }
  }

  function updateUserStats(users) {
    var stat = $("#stat-users");
    if (stat) stat.textContent = users.length;
    var countEl = $("#users-count");
    if (countEl) countEl.textContent = users.length + " user" + (users.length === 1 ? "" : "s");

    var now = Date.now();
    var ONLINE_WINDOW = 2 * 60 * 1000;
    var online = 0, offline = 0;
    users.forEach(function (u) {
      if (u.lastSeen && u.lastSeen.toDate) {
        var diff = now - u.lastSeen.toDate().getTime();
        if (diff < ONLINE_WINDOW) online++;
        else offline++;
      } else { offline++; }
    });
    var onlineEl = $("#stat-online");
    var offlineEl = $("#stat-offline");
    if (onlineEl) onlineEl.textContent = online;
    if (offlineEl) offlineEl.textContent = offline;

    var onlineDot = $("#online-dot");
    if (onlineDot) {
      onlineDot.style.background = online > 0 ? "var(--accent)" : "var(--text-muted)";
      onlineDot.style.boxShadow = online > 0 ? "0 0 8px var(--accent)" : "none";
    }
  }

  function setOrders(orders) {
    currentOrders = orders;
    renderOrders(orders);
  }

  function renderAdminProducts(products) {
    var grid = $("#admin-product-grid");
    if (!grid) return;
    if (!products.length) {
      grid.innerHTML =
        '<div class="empty-state" style="grid-column: 1/-1">' +
          '<div class="icon">&#128190;</div>' +
          '<h3 style="color:var(--text); font-family:var(--font-display); letter-spacing:2px; margin-bottom: 8px;">NO PRODUCTS</h3>' +
          '<p>Click "+ ADD PRODUCT" to create your first item.</p>' +
        '</div>';
      return;
    }
    grid.innerHTML = "";
    products.forEach(function (p, i) {
      var card = document.createElement("div");
      card.className = "admin-card fade-in";
      card.style.animationDelay = (i * 40) + "ms";
      card.innerHTML =
        '<div class="img-wrap" ' + (p.imageUrl ? "style=\"background-image:url('" + escapeHtml(p.imageUrl) + "')\"" : "") + '>' +
          (p.category ? '<span class="badge" style="position:absolute; top:10px; left:10px; background:var(--primary); color:#001014; font-size:0.7rem; font-weight:800; padding:3px 8px; border-radius:4px; z-index:2;">' + escapeHtml(p.category) + '</span>' : "") +
        '</div>' +
        '<div class="body">' +
          '<h4>' + escapeHtml(p.title || "Untitled") + '</h4>' +
          '<div style="color:var(--text-dim); font-size:0.85rem; margin-bottom: 8px;">' + escapeHtml((p.description || "").slice(0, 60)) + ((p.description || "").length > 60 ? "..." : "") + '</div>' +
          '<div class="price">' + formatPrice(p.price) + '</div>' +
        '</div>' +
        '<div class="actions">' +
          '<button class="btn btn-ghost btn-sm" data-edit="' + escapeHtml(p.id) + '">EDIT</button>' +
          '<button class="btn btn-danger btn-sm" data-delete="' + escapeHtml(p.id) + '">DELETE</button>' +
        '</div>';
      grid.appendChild(card);
    });
    grid.querySelectorAll("[data-edit]").forEach(function (btn) { btn.addEventListener("click", function () { editProduct(btn.dataset.edit); }); });
    grid.querySelectorAll("[data-delete]").forEach(function (btn) { btn.addEventListener("click", function () { deleteProduct(btn.dataset.delete); }); });
  }

  function renderOrders(orders) {
    var container = $("#orders-container");
    if (!container) return;
    var filtered = currentOrderFilter === "all"
      ? orders
      : orders.filter(function (o) { return (o.status || "pending") === currentOrderFilter; });
    if (!filtered.length) {
      container.innerHTML =
        '<div class="empty-state">' +
          '<div class="icon">&#128722;</div>' +
          '<h3 style="color:var(--text); font-family:var(--font-display); letter-spacing:2px; margin-bottom: 8px;">NO ORDERS</h3>' +
          '<p>' + (orders.length === 0 ? "No orders yet. They'll appear here when customers place them." : "No orders match the current filter.") + '</p>' +
        '</div>';
      return;
    }
    container.innerHTML = "";
    filtered.forEach(function (o, i) {
      var card = document.createElement("div");
      card.className = "order-card fade-in";
      card.style.animationDelay = (i * 30) + "ms";
      card.innerHTML =
        '<div class="order-card-header">' +
          '<div>' +
            '<div style="font-family: var(--font-display); font-size: 1.05rem; letter-spacing: 1px; margin-bottom: 4px;">' + escapeHtml(o.productTitle) + '</div>' +
            '<div class="order-id">ORDER #' + escapeHtml(o.id.slice(0, 12).toUpperCase()) + '</div>' +
          '</div>' +
          '<div style="text-align: right;">' +
            '<span class="order-status ' + escapeHtml(o.status || "pending") + '">' + escapeHtml(o.status || "pending") + '</span>' +
            '<div style="color: var(--primary); font-family: var(--font-display); font-weight: 800; margin-top: 6px; font-size: 1.1rem;">' + formatPrice(o.productPrice) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="order-card-body">' +
          '<div class="order-field"><div class="label">Customer</div><div class="value">' + escapeHtml(o.customerName) + '</div></div>' +
          '<div class="order-field"><div class="label">Phone</div><div class="value"><a href="tel:' + escapeHtml(o.customerPhone) + '">' + escapeHtml(o.customerPhone) + '</a></div></div>' +
          '<div class="order-field"><div class="label">Email</div><div class="value"><a href="mailto:' + escapeHtml(o.customerEmail) + '">' + escapeHtml(o.customerEmail) + '</a></div></div>' +
          (o.customerAddress ? '<div class="order-field"><div class="label">Address</div><div class="value">' + escapeHtml(o.customerAddress) + '</div></div>' : "") +
          (o.notes ? '<div class="order-field" style="grid-column: 1/-1"><div class="label">Notes</div><div class="value">' + escapeHtml(o.notes) + '</div></div>' : "") +
          (o.userFingerprint ? '<div class="order-field"><div class="label">Device FP</div><div class="value" style="font-family:var(--font-mono); font-size:0.75rem; color:var(--primary);">' + escapeHtml(o.userFingerprint.slice(0, 24) + "...") + '</div></div>' : "") +
          '<div class="order-field"><div class="label">Placed</div><div class="value">' + formatDate(o.createdAt) + '</div></div>' +
        '</div>' +
        '<div class="order-card-footer">' +
          '<button class="btn btn-ghost btn-sm" data-status="contacted" data-order="' + escapeHtml(o.id) + '" ' + (o.status === "contacted" ? "disabled" : "") + '>MARK CONTACTED</button>' +
          '<button class="btn btn-ghost btn-sm" data-status="completed" data-order="' + escapeHtml(o.id) + '" ' + (o.status === "completed" ? "disabled" : "") + '>COMPLETE</button>' +
          '<button class="btn btn-ghost btn-sm" data-status="cancelled" data-order="' + escapeHtml(o.id) + '" ' + (o.status === "cancelled" ? "disabled" : "") + '>CANCEL</button>' +
          '<button class="btn btn-danger btn-sm" data-delete-order="' + escapeHtml(o.id) + '">DELETE</button>' +
        '</div>';
      container.appendChild(card);
    });
    container.querySelectorAll("[data-status]").forEach(function (btn) { btn.addEventListener("click", function () { updateOrderStatus(btn.dataset.order, btn.dataset.status); }); });
    container.querySelectorAll("[data-delete-order]").forEach(function (btn) { btn.addEventListener("click", function () { deleteOrder(btn.dataset.deleteOrder); }); });
  }

  function renderUsers(users) {
    var tbody = $("#users-tbody");
    if (!tbody) return;
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 40px; color: var(--text-dim);">No registered users yet.</td></tr>';
      return;
    }
    tbody.innerHTML = "";
    var now = Date.now();
    var ONLINE_WINDOW = 2 * 60 * 1000;
    var currentIsOwner = currentUser && isOwner(currentUser);
    users.forEach(function (u) {
      var isAdminUser = isAdminEmail(u.email);
      var isSelf = currentUser && u.id === currentUser.uid;
      var onlineLabel = "Offline";
      var onlineClass = "danger";
      if (u.lastSeen && u.lastSeen.toDate) {
        var diff = now - u.lastSeen.toDate().getTime();
        if (diff < ONLINE_WINDOW) { onlineLabel = "Online"; onlineClass = "success"; }
      }
      var fp = u.fingerprint || "—";
      var fpDisplay = fp === "—" ? "—" : (fp.length > 20 ? fp.slice(0, 20) + "…" : fp);
      var fpTitle = fp === "—" ? "No fingerprint recorded" : fp;
      var fpChanged = u.fingerprintChangedAt ? " <span style='color:var(--warn);' title='Fingerprint changed' title='FP changed'>⚠</span>" : "";
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td style="font-weight: 600;">' + escapeHtml(u.displayName || "—") +
          (isAdminUser ? '<span class="badge-soft" style="background:rgba(176,38,255,0.15); color:var(--secondary); margin-left:6px;">ADMIN</span>' : "") +
          (isSelf ? '<span class="badge-soft" style="margin-left:6px;">YOU</span>' : "") +
        '</td>' +
        '<td style="word-break: break-all;">' + escapeHtml(u.email || "—") + '</td>' +
        '<td><span class="fingerprint-cell" title="' + escapeHtml(fpTitle) + '" data-copy="' + escapeHtml(fp) + '">' + escapeHtml(fpDisplay) + '</span>' + fpChanged + '</td>' +
        '<td><span class="badge-soft ' + onlineClass + '">' + onlineLabel + '</span></td>' +
        '<td style="color:var(--text-dim); font-size:0.85rem;" title="' + escapeHtml(formatDate(u.lastSeen)) + '">' + escapeHtml(timeAgo(u.lastSeen)) + '</td>' +
        '<td style="text-align:right; white-space:nowrap;">' +
          (!isAdminUser && currentIsOwner ? '<button class="btn btn-secondary btn-sm" data-promote="' + escapeHtml(u.id) + '" data-email="' + escapeHtml(u.email) + '" style="margin-right:4px;">PROMOTE</button>' : "") +
          (isAdminUser && !isOwner({ email: u.email }) && currentIsOwner ? '<button class="btn btn-ghost btn-sm" data-demote="' + escapeHtml(u.id) + '" data-email="' + escapeHtml(u.email) + '" style="margin-right:4px;">DEMOTE</button>' : "") +
          (u.fingerprint && u.fingerprint !== "—" && !isSelf ? '<button class="btn btn-ghost btn-sm" data-block-fp="' + escapeHtml(u.fingerprint) + '" data-email="' + escapeHtml(u.email) + '" style="margin-right:4px;" title="Block this device">BLOCK</button>' : "") +
          (!isSelf ? '<button class="btn btn-danger btn-sm" data-delete-user="' + escapeHtml(u.id) + '" data-email="' + escapeHtml(u.email) + '">DEL</button>' : '<span style="color:var(--text-muted); font-size:0.85rem;">—</span>') +
        '</td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll("[data-promote]").forEach(function (btn) { btn.addEventListener("click", function () { promoteAdmin(btn.dataset.email); }); });
    tbody.querySelectorAll("[data-demote]").forEach(function (btn) { btn.addEventListener("click", function () { demoteAdmin(btn.dataset.email); }); });
    tbody.querySelectorAll("[data-delete-user]").forEach(function (btn) { btn.addEventListener("click", function () { deleteUser(btn.dataset.deleteUser, btn.dataset.email); }); });
    tbody.querySelectorAll("[data-block-fp]").forEach(function (btn) {
      btn.addEventListener("click", function () { quickBlockDevice(btn.dataset.blockFp, btn.dataset.email); });
    });
    tbody.querySelectorAll(".fingerprint-cell").forEach(function (cell) {
      cell.addEventListener("click", function () {
        var val = cell.getAttribute("data-copy");
        if (val && val !== "—") {
          try { navigator.clipboard.writeText(val).then(function () { showToast("Fingerprint copied", "success"); }); } catch (e) {}
        }
      });
    });
  }

  function renderAdminsList() {
    var tbody = $("#admins-tbody");
    if (!tbody) return;
    var all = [OWNER_EMAIL].concat(adminEmailsCache.filter(function (e) { return e.toLowerCase() !== OWNER_EMAIL.toLowerCase(); }));
    var currentIsOwner = currentUser && isOwner(currentUser);
    tbody.innerHTML = "";
    all.forEach(function (email) {
      var isOwnerEmail = email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td style="font-weight: 600; word-break: break-all;">' + escapeHtml(email) + '</td>' +
        '<td>' + (isOwnerEmail ? '<span class="badge-soft" style="background:rgba(176,38,255,0.2); color:var(--secondary);">OWNER</span>' : '<span class="badge-soft">ADMIN</span>') + '</td>' +
        '<td style="text-align:right;">' +
          (!isOwnerEmail ? (currentIsOwner ? '<button class="btn btn-danger btn-sm" data-remove-admin="' + escapeHtml(email) + '">REMOVE</button>' : '<span style="color:var(--text-muted); font-size:0.85rem;">Owner-only action</span>') : '<span style="color:var(--text-muted); font-size:0.85rem;">Permanent</span>') +
        '</td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll("[data-remove-admin]").forEach(function (btn) { btn.addEventListener("click", function () { demoteAdmin(btn.dataset.removeAdmin); }); });
  }

  function renderBlocks(blocks) {
    var tbody = $("#blocks-tbody");
    if (!tbody) return;
    if (!blocks.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 40px; color: var(--text-dim);">No blocked devices.</td></tr>';
      return;
    }
    tbody.innerHTML = "";
    blocks.forEach(function (b) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td><span class="fingerprint-cell" title="' + escapeHtml(b.id) + '" data-copy="' + escapeHtml(b.id) + '">' + escapeHtml(b.id) + '</span></td>' +
        '<td>' + escapeHtml(b.reason || "—") + '</td>' +
        '<td style="max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-dim); font-size:0.85rem;">' + escapeHtml((b.userAgent || "—").slice(0, 60)) + '</td>' +
        '<td style="color:var(--text-dim); font-size:0.85rem;">' + formatDate(b.blockedAt) + '</td>' +
        '<td style="text-align:right"><button class="btn btn-ghost btn-sm" data-unblock="' + escapeHtml(b.id) + '">UNBLOCK</button></td>';
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll("[data-unblock]").forEach(function (btn) { btn.addEventListener("click", function () { unblockDevice(btn.dataset.unblock); }); });
    tbody.querySelectorAll(".fingerprint-cell").forEach(function (cell) {
      cell.addEventListener("click", function () {
        var val = cell.getAttribute("data-copy");
        if (val) { try { navigator.clipboard.writeText(val).then(function () { showToast("Copied", "success"); }); } catch (e) {} }
      });
    });
  }

  function updateStats(products) {
    $("#stat-total").textContent = products.length;
    if (products.length) {
      var avg = products.reduce(function (s, p) { return s + Number(p.price || 0); }, 0) / products.length;
      $("#stat-avg").textContent = avg.toFixed(2) + " ج.م";
    } else { $("#stat-avg").textContent = "0 ج.م"; }
  }

  function uploadImage(file) {
    if (!file) return Promise.resolve(null);
    var allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) return Promise.reject(new Error("Unsupported image format (use JPG, PNG, WEBP)"));
    if (file.size > 15 * 1024 * 1024) return Promise.reject(new Error("File too large (max 15MB before compression)"));
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          var maxW = 1200;
          var scale = Math.min(1, maxW / img.width);
          var w = Math.round(img.width * scale);
          var h = Math.round(img.height * scale);
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          var dataUrl = canvas.toDataURL("image/jpeg", 0.75);
          if (dataUrl.length > 950 * 1024) reject(new Error("Image too large after compression. Try a smaller image."));
          else resolve({ url: dataUrl });
        };
        img.onerror = function () { reject(new Error("Failed to read image")); };
        img.src = e.target.result;
      };
      reader.onerror = function () { reject(new Error("Failed to read file")); };
      reader.readAsDataURL(file);
    });
  }

  async function saveProduct(e) {
    e.preventDefault();
    var editId = $("#edit-id").value;
    var file = $("#product-image").files[0];
    var saveBtn = $("#save-btn");
    var origText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = editId ? "UPDATING..." : "UPLOADING...";
    try {
      var title = $("#product-title").value.trim();
      var description = $("#product-desc").value.trim();
      var price = parseFloat($("#product-price").value);
      var category = $("#product-category").value.trim();
      if (!title || !description || isNaN(price) || price < 0) throw new Error("Please fill in all required fields with valid values");
      var imageUrl = null;
      if (editId) {
        var snap = await db.collection(COLLECTIONS.PRODUCTS).doc(editId).get();
        if (snap.exists) imageUrl = snap.data().imageUrl;
      }
      if (file) {
        var uploaded = await uploadImage(file);
        imageUrl = uploaded.url;
      }
      var payload = {
        title: title, description: description, price: price,
        category: category || null,
        imageUrl: imageUrl,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: currentUser ? currentUser.email : null
      };
      if (editId) {
        await db.collection(COLLECTIONS.PRODUCTS).doc(editId).update(payload);
        showToast("Product updated successfully", "success", "UPDATED");
      } else {
        payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        payload.createdBy = currentUser ? currentUser.email : null;
        await db.collection(COLLECTIONS.PRODUCTS).add(payload);
        showToast("Product added to catalog", "success", "DEPLOYED");
      }
      resetProductForm();
      closeModals();
    } catch (err) {
      showToast(err.message, "error", "SAVE FAILED");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = origText;
    }
  }

  async function editProduct(id) {
    try {
      var snap = await db.collection(COLLECTIONS.PRODUCTS).doc(id).get();
      if (!snap.exists) return;
      var p = snap.data();
      $("#edit-id").value = id;
      $("#form-title").textContent = "// Edit Product";
      $("#product-title").value = p.title || "";
      $("#product-desc").value = p.description || "";
      $("#product-price").value = p.price || 0;
      $("#product-category").value = p.category || "";
      var preview = $("#image-preview");
      var prompt = $("#upload-prompt");
      if (p.imageUrl) { preview.src = p.imageUrl; preview.style.display = "block"; prompt.style.display = "none"; }
      else { preview.style.display = "none"; prompt.style.display = "block"; }
      openModal("product-form-modal");
    } catch (e) { showToast("Failed to load product", "error"); }
  }

  async function deleteProduct(id) {
    if (!confirm("Delete this product? This cannot be undone.")) return;
    try {
      await db.collection(COLLECTIONS.PRODUCTS).doc(id).delete();
      logAdminEvent("product_delete", id);
      showToast("Product removed", "success", "DELETED");
    } catch (e) { showToast("Delete failed: " + e.message, "error"); }
  }

  function resetProductForm() {
    $("#product-form").reset();
    $("#edit-id").value = "";
    $("#form-title").textContent = "// New Product";
    $("#image-preview").style.display = "none";
    $("#upload-prompt").style.display = "block";
  }

  async function blockDevice(e) {
    e.preventDefault();
    var id = $("#block-id").value.trim();
    var reason = $("#block-reason").value.trim();
    var ua = $("#block-ua").value.trim() || navigator.userAgent;
    if (!id || !reason) return;
    if (id.length > 100 || reason.length > 200) { showToast("Input too long", "error"); return; }
    try {
      await db.collection(COLLECTIONS.BLOCKED).doc(id).set({
        reason: reason, userAgent: ua.slice(0, 300),
        blockedAt: firebase.firestore.FieldValue.serverTimestamp(),
        blockedBy: currentUser ? currentUser.email : null
      });
      logAdminEvent("device_block", id);
      showToast("Device blocked", "success", "BLOCKED");
      $("#block-form").reset();
      closeModals();
    } catch (err) { showToast("Block failed: " + err.message, "error"); }
  }

  function quickBlockDevice(fp, email) {
    if (!fp) return;
    if (!confirm("Block device for " + email + "?\n\nFingerprint: " + fp.slice(0, 24) + "...")) return;
    var reason = "Quick block via user: " + email;
    db.collection(COLLECTIONS.BLOCKED).doc(fp).set({
      reason: reason,
      userAgent: navigator.userAgent.slice(0, 300),
      blockedAt: firebase.firestore.FieldValue.serverTimestamp(),
      blockedBy: currentUser ? currentUser.email : null,
      targetEmail: email
    }).then(function () {
      logAdminEvent("quick_device_block", fp);
      showToast("Device blocked", "success");
    }).catch(function (e) { showToast("Block failed: " + e.message, "error"); });
  }

  async function unblockDevice(id) {
    if (!confirm("Unblock device " + id.slice(0, 16) + "...?")) return;
    try {
      await db.collection(COLLECTIONS.BLOCKED).doc(id).delete();
      logAdminEvent("device_unblock", id);
      showToast("Device unblocked", "success", "REMOVED");
    } catch (e) { showToast("Unblock failed: " + e.message, "error"); }
  }

  async function updateOrderStatus(id, status) {
    try {
      await db.collection(COLLECTIONS.ORDERS).doc(id).update({ status: status, statusUpdatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      logAdminEvent("order_status", id + " -> " + status);
      showToast("Order marked as " + status, "success");
    } catch (e) { showToast("Update failed: " + e.message, "error"); }
  }

  async function deleteOrder(id) {
    if (!confirm("Delete this order?")) return;
    try {
      await db.collection(COLLECTIONS.ORDERS).doc(id).delete();
      logAdminEvent("order_delete", id);
      showToast("Order deleted", "success");
    } catch (e) { showToast("Delete failed: " + e.message, "error"); }
  }

  async function promoteAdmin(email) {
    if (!email) return;
    if (email.toLowerCase() === OWNER_EMAIL.toLowerCase()) { showToast("Owner is already an admin", "info"); return; }
    if (!confirm("Promote " + email + " to admin?")) return;
    try {
      var list = adminEmailsCache.filter(function (e) { return e.toLowerCase() !== email.toLowerCase(); });
      list.push(email.toLowerCase());
      await db.collection(COLLECTIONS.CONFIG).doc("admins").update({
        emails: Array.from(new Set(list)),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: currentUser ? currentUser.email : null
      });
      logAdminEvent("admin_promote", email);
      showToast(email + " promoted to admin", "success");
    } catch (e) { showToast("Promote failed: " + e.message, "error"); }
  }

  async function demoteAdmin(email) {
    if (!email) return;
    if (email.toLowerCase() === OWNER_EMAIL.toLowerCase()) { showToast("Cannot remove the owner", "error"); return; }
    if (!confirm("Remove " + email + " from admins?")) return;
    try {
      var list = adminEmailsCache.filter(function (e) { return e.toLowerCase() !== email.toLowerCase(); });
      await db.collection(COLLECTIONS.CONFIG).doc("admins").update({
        emails: list,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: currentUser ? currentUser.email : null
      });
      logAdminEvent("admin_demote", email);
      showToast(email + " removed from admins", "success");
    } catch (e) { showToast("Demote failed: " + e.message, "error"); }
  }

  async function deleteUser(uid, email) {
    if (!confirm("Delete user " + email + "? This removes their account data.")) return;
    try {
      await db.collection(COLLECTIONS.USERS).doc(uid).delete();
      logAdminEvent("user_delete", uid);
      showToast("User " + email + " deleted", "success", "REMOVED");
    } catch (e) { showToast("Delete failed: " + e.message, "error"); }
  }

  async function loadTelegramConfig() {
    try {
      var doc = await db.collection(COLLECTIONS.CONFIG).doc("telegram").get();
      if (doc.exists) {
        var data = doc.data();
        $("#tg-token").value = data.botToken || "";
        $("#tg-chat").value = data.chatId || "";
        $("#tg-enabled").checked = data.enabled !== false;
        updateTelegramStatus(true, !!(data.botToken && data.chatId));
      } else { updateTelegramStatus(true, false); }
    } catch (e) { updateTelegramStatus(false, false); }
  }

  function updateTelegramStatus(loaded, configured) {
    var el = $("#telegram-status");
    if (!el) return;
    if (!loaded) {
      el.className = "config-status disconnected";
      el.innerHTML = '<span class="dot"></span><span>Failed to load configuration</span>';
    } else if (configured) {
      el.className = "config-status connected";
      el.innerHTML = '<span class="dot"></span><span>Telegram bot configured and active</span>';
    } else {
      el.className = "config-status disconnected";
      el.innerHTML = '<span class="dot"></span><span>Not configured. Orders will still save but no Telegram notifications will be sent.</span>';
    }
  }

  async function saveTelegramConfig(e) {
    e.preventDefault();
    var botToken = $("#tg-token").value.trim();
    var chatId = $("#tg-chat").value.trim();
    var enabled = $("#tg-enabled").checked;
    try {
      await db.collection(COLLECTIONS.CONFIG).doc("telegram").set({
        botToken: botToken, chatId: chatId, enabled: enabled,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: currentUser ? currentUser.email : null
      }, { merge: true });
      logAdminEvent("telegram_config_update", "enabled=" + enabled);
      showToast("Telegram config saved", "success");
      updateTelegramStatus(true, botToken && chatId);
    } catch (err) { showToast("Save failed: " + err.message, "error"); }
  }

  async function testTelegram() {
    var botToken = $("#tg-token").value.trim();
    var chatId = $("#tg-chat").value.trim();
    if (!botToken || !chatId) { showToast("Please fill in token and chat ID first", "error"); return; }
    var text = encodeURIComponent("✅ *Telegram Test*\n\nYour SynaxMatrix bot is connected and ready.");
    var url = "https://api.telegram.org/bot" + botToken + "/sendMessage?chat_id=" + chatId + "&parse_mode=Markdown&text=" + text;
    try {
      var res = await fetch(url);
      var data = await res.json();
      if (data.ok) showToast("Test message sent!", "success");
      else showToast("Telegram error: " + (data.description || "unknown"), "error");
    } catch (e) { showToast("Network error: " + e.message, "error"); }
  }

  function checkAdminLoginLock() {
    try {
      var until = parseInt(localStorage.getItem("cy_admin_lockout_until") || "0", 10);
      if (!until) return false;
      if (Date.now() < until) {
        var secs = Math.ceil((until - Date.now()) / 1000);
        return "Too many failed attempts. Try again in " + secs + "s";
      }
      localStorage.removeItem("cy_admin_lockout_until");
      localStorage.removeItem("cy_admin_attempts");
      return false;
    } catch (e) { return false; }
  }

  function recordAdminLoginAttempt(success) {
    try {
      if (success) {
        localStorage.removeItem("cy_admin_attempts");
        localStorage.removeItem("cy_admin_lockout_until");
        loginAttempts = 0;
        return;
      }
      loginAttempts++;
      localStorage.setItem("cy_admin_attempts", String(loginAttempts));
      if (loginAttempts >= 5) {
        localStorage.setItem("cy_admin_lockout_until", String(Date.now() + 60000));
        loginAttempts = 0;
      }
    } catch (e) {}
  }

  function attachLogin() {
    $("#login-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var lockMsg = checkAdminLoginLock();
      if (lockMsg) { showToast(lockMsg, "error"); return; }
      var email = $("#email").value.trim();
      var password = $("#password").value;
      var errBox = $("#login-error");
      var btnText = $("#login-btn-text");
      errBox.style.display = "none";
      btnText.textContent = "AUTHENTICATING...";
      try {
        await auth.signInWithEmailAndPassword(email, password);
        recordAdminLoginAttempt(true);
      } catch (err) {
        recordAdminLoginAttempt(false);
        errBox.textContent = friendlyAuthError(err.code);
        errBox.style.display = "block";
        btnText.textContent = "AUTHENTICATE";
      }
    });

    $("#logout-btn").addEventListener("click", async function () {
      try { await auth.signOut(); window.location.href = "index.html"; }
      catch (e) { showToast("Logout failed", "error"); }
    });

    $("#denied-logout-btn").addEventListener("click", async function () {
      try { await auth.signOut(); window.location.href = "index.html"; }
      catch (e) { showToast("Logout failed", "error"); }
    });
  }

  function friendlyAuthError(code) {
    var map = {
      "auth/invalid-email": "Invalid email format",
      "auth/user-not-found": "No operator found with these credentials",
      "auth/wrong-password": "Incorrect access key",
      "auth/invalid-credential": "Invalid email or password",
      "auth/too-many-requests": "Too many attempts. Try again later.",
      "auth/network-request-failed": "Network error. Check your connection."
    };
    return map[code] || "Authentication failed. Check your credentials.";
  }

  function attachTabs() {
    $$(".nav-item[data-tab]").forEach(function (item) {
      item.addEventListener("click", function () {
        $$(".nav-item").forEach(function (n) { n.classList.remove("active"); });
        item.classList.add("active");
        var tab = item.dataset.tab;
        ["products", "orders", "users", "admins", "blocks", "telegram"].forEach(function (t) {
          var sec = $("#tab-" + t);
          if (sec) sec.style.display = t === tab ? "block" : "none";
        });
        if (tab === "admins") renderAdminsList();
      });
    });
    var filter = $("#order-filter");
    if (filter) {
      filter.addEventListener("change", function (e) {
        currentOrderFilter = e.target.value;
        if (currentOrders.length) renderOrders(currentOrders);
      });
    }
  }

  function attachSidebar() {
    var toggle = $("#sidebar-toggle");
    var sidebar = $("#sidebar");
    if (!toggle || !sidebar) return;
    var backdrop = document.createElement("div");
    backdrop.className = "sidebar-backdrop";
    document.body.appendChild(backdrop);
    var open = function () { sidebar.classList.add("open"); backdrop.classList.add("open"); document.body.style.overflow = "hidden"; };
    var close = function () { sidebar.classList.remove("open"); backdrop.classList.remove("open"); document.body.style.overflow = ""; };
    toggle.addEventListener("click", function () { if (sidebar.classList.contains("open")) close(); else open(); });
    backdrop.addEventListener("click", close);
    sidebar.querySelectorAll(".nav-item, .btn").forEach(function (el) { el.addEventListener("click", function () { if (window.innerWidth <= 900) setTimeout(close, 100); }); });
  }

  function attachModalEvents() {
    $$("[data-close]").forEach(function (el) { el.addEventListener("click", closeModals); });
    $$(".modal-overlay").forEach(function (m) {
      m.addEventListener("click", function (e) { if (e.target === m) closeModals(); });
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModals(); });

    $("#add-product-btn").addEventListener("click", function () { resetProductForm(); openModal("product-form-modal"); });
    $("#add-block-btn").addEventListener("click", function () { openModal("block-form-modal"); });

    $("#product-form").addEventListener("submit", saveProduct);
    $("#block-form").addEventListener("submit", blockDevice);
    $("#telegram-form").addEventListener("submit", saveTelegramConfig);
    $("#tg-test-btn").addEventListener("click", testTelegram);

    var fileInput = $("#product-image");
    var preview = $("#image-preview");
    var prompt = $("#upload-prompt");
    var dropZone = $("#file-drop");
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        var file = fileInput.files[0];
        if (file) {
          var reader = new FileReader();
          reader.onload = function (e) { preview.src = e.target.result; preview.style.display = "block"; prompt.style.display = "none"; };
          reader.readAsDataURL(file);
        }
      });
    }
    if (dropZone) {
      ["dragover", "dragenter"].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) { e.preventDefault(); dropZone.classList.add("dragover"); });
      });
      ["dragleave", "drop"].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) { e.preventDefault(); dropZone.classList.remove("dragover"); });
      });
      dropZone.addEventListener("drop", function (e) {
        var files = e.dataTransfer.files;
        if (files && files[0] && fileInput) {
          fileInput.files = files;
          fileInput.dispatchEvent(new Event("change"));
        }
      });
    }
  }

  function init() {
    attachLogin();
    attachTabs();
    attachSidebar();
    attachModalEvents();
    attachDiagnostics();

    auth.onAuthStateChanged(async function (user) {
      currentUser = user;
      if (user) {
        currentUserIsAdmin = isAdminEmail(user.email);
        if (currentUserIsAdmin) {
          await ensureAdminDoc();
          try {
            await db.collection(COLLECTIONS.USERS).doc(user.uid).set({
              email: user.email,
              lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          } catch (e) {}
        }
        setAuthUI(user);
      } else {
        currentUserIsAdmin = false;
        setAuthUI(null);
      }
    });

    startAdminListListener();
  }

  function attachDiagnostics() {
    var fab = document.getElementById("diag-fab");
    if (fab) {
      fab.addEventListener("click", function () { openModal("diagnostics-modal"); runDiagnostics(); });
    }
    var runBtn = document.getElementById("run-diag-btn");
    if (runBtn) runBtn.addEventListener("click", runDiagnostics);
  }

  async function runDiagnostics() {
    var el = document.getElementById("diag-content");
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text-dim);">Running tests...</div>';

    var lines = [];
    var u = currentUser;

    lines.push("═══════════════════════════════════════");
    lines.push("       SYSTEM DIAGNOSTICS v1.0");
    lines.push("═══════════════════════════════════════");
    lines.push("");

    if (!u) {
      lines.push("❌ NOT SIGNED IN");
      el.innerHTML = lines.join("<br>");
      return;
    }

    lines.push("👤 AUTH INFO");
    lines.push("   Email: " + (u.email || "—"));
    lines.push("   UID: " + (u.uid || "—"));
    lines.push("   Email Verified: " + (u.emailVerified ? "✓" : "✗"));
    lines.push("");

    var lower = (u.email || "").toLowerCase();
    lines.push("🔐 OWNER CHECK");
    lines.push("   Hardcoded owner: " + OWNER_EMAIL);
    lines.push("   Your email: " + u.email);
    lines.push("   Lowercase match: " + (lower === OWNER_EMAIL.toLowerCase() ? "✓ YES" : "✗ NO"));
    lines.push("   isOwner(): " + (isOwner(u) ? "✓ TRUE" : "✗ FALSE"));
    lines.push("");

    lines.push("📋 ADMIN LIST (config/admins)");
    lines.push("   Emails: " + JSON.stringify(adminEmailsCache));
    lines.push("   isAdminEmail(): " + (isAdminEmail(u.email) ? "✓ TRUE" : "✗ FALSE"));
    lines.push("");

    lines.push("🧪 PERMISSION TESTS");
    try {
      var testRead = await db.collection(COLLECTIONS.BLOCKED).limit(1).get();
      lines.push("   ✓ Read blockedDevices: SUCCESS (" + testRead.size + " docs)");
    } catch (e) { lines.push("   ✗ Read blockedDevices: FAILED — " + e.message); }

    try {
      var testReadOrders = await db.collection(COLLECTIONS.ORDERS).limit(1).get();
      lines.push("   ✓ Read orders: SUCCESS (" + testReadOrders.size + " docs)");
    } catch (e) { lines.push("   ✗ Read orders: FAILED — " + e.message); }

    try {
      var testWriteId = "_test_" + Date.now();
      await db.collection(COLLECTIONS.BLOCKED).doc(testWriteId).set({
        reason: "DIAGNOSTIC_TEST",
        blockedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await db.collection(COLLECTIONS.BLOCKED).doc(testWriteId).delete();
      lines.push("   ✓ Write/Delete blockedDevices: SUCCESS");
    } catch (e) { lines.push("   ✗ Write blockedDevices: FAILED — " + e.message); }

    try {
      var testOrderId = "_test_order_" + Date.now();
      await db.collection(COLLECTIONS.ORDERS).doc(testOrderId).set({
        productTitle: "DIAGNOSTIC_TEST",
        status: "test",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await db.collection(COLLECTIONS.ORDERS).doc(testOrderId).delete();
      lines.push("   ✓ Write/Delete orders: SUCCESS");
    } catch (e) { lines.push("   ✗ Write orders: FAILED — " + e.message); }

    try {
      var cfgRef = await db.collection(COLLECTIONS.CONFIG).doc("admins").get();
      if (cfgRef.exists) {
        lines.push("   ✓ Read config/admins: SUCCESS (emails=" + JSON.stringify(cfgRef.data().emails) + ")");
      } else { lines.push("   ⚠ config/admins doc does NOT exist yet"); }
    } catch (e) { lines.push("   ✗ Read config/admins: FAILED — " + e.message); }

    lines.push("");
    lines.push("═══════════════════════════════════════");

    el.innerHTML = lines.map(function (l) {
      var color = "var(--text)";
      if (l.includes("✗")) color = "var(--danger)";
      else if (l.includes("✓")) color = "var(--accent)";
      else if (l.includes("⚠")) color = "var(--warn)";
      else if (l.startsWith("═") || l.includes("INFO") || l.includes("CHECK") || l.includes("LIST") || l.includes("TESTS")) color = "var(--primary)";
      return '<div style="color:' + color + ';">' + escapeHtml(l) + '</div>';
    }).join("");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
