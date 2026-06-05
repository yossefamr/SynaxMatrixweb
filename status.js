(function () {
  "use strict";

  var REFRESH_INTERVAL = 30000;
  var refreshTimer = null;
  var stats = { products: 0, users: 0, orders: 0, online: 0, blocks: 0 };

  function $(sel) { return document.querySelector(sel); }
  function setText(id, text) { var el = $("#" + id); if (el) el.textContent = text; }

  function formatRelative(d) {
    var diff = Date.now() - d.getTime();
    if (diff < 60000) return Math.floor(diff / 1000) + "s ago";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return d.toLocaleDateString();
  }

  function setServiceStatus(id, state, label) {
    var el = $("#" + id);
    if (!el) return;
    el.className = "service-status " + state;
    el.innerHTML = '<span class="dot"></span>' + label;
  }

  async function testDatabase() {
    var t0 = performance.now();
    try {
      await db.collection("products").limit(1).get();
      var latency = Math.round(performance.now() - t0);
      setServiceStatus("db-status", latency < 500 ? "operational" : (latency < 1500 ? "degraded" : "down"), latency < 1500 ? "Operational" : "Degraded");
      var bar = $("#db-latency-bar");
      var lat = $("#db-latency");
      if (bar) bar.style.width = Math.min(100, (latency / 20)) + "%";
      if (lat) lat.textContent = latency + " ms";
      return latency;
    } catch (e) {
      setServiceStatus("db-status", "down", "Down");
      return -1;
    }
  }

  async function testAuth() {
    try {
      var u = auth.currentUser;
      setServiceStatus("auth-status", "operational", "Operational");
      setText("auth-info", u ? "Signed in" : "Ready");
      return true;
    } catch (e) {
      setServiceStatus("auth-status", "down", "Down");
      setText("auth-info", "Error");
      return false;
    }
  }

  async function testTelegram() {
    try {
      var doc = await db.collection("config").doc("telegram").get();
      if (!doc.exists) {
        setServiceStatus("telegram-status", "degraded", "Not Configured");
        setText("tg-info", "Configure from admin panel");
        var bar = $("#tg-bar"); if (bar) bar.style.width = "30%";
        return false;
      }
      var data = doc.data() || {};
      if (!data.botToken || !data.chatId) {
        setServiceStatus("telegram-status", "degraded", "Incomplete Config");
        setText("tg-info", "Missing token or chat ID");
        var bar = $("#tg-bar"); if (bar) bar.style.width = "30%";
        return false;
      }
      var t0 = performance.now();
      var res = await fetch("https://api.telegram.org/bot" + data.botToken + "/getMe");
      var json = await res.json();
      var latency = Math.round(performance.now() - t0);
      if (json.ok) {
        setServiceStatus("telegram-status", "operational", "Online");
        setText("tg-info", "@" + (json.result.username || "bot") + " · " + latency + "ms");
        var bar = $("#tg-bar"); if (bar) bar.style.width = "100%";
        return true;
      } else {
        setServiceStatus("telegram-status", "down", "Auth Error");
        setText("tg-info", (json.description || "Invalid token").slice(0, 50));
        var bar = $("#tg-bar"); if (bar) bar.style.width = "0%";
        return false;
      }
    } catch (e) {
      setServiceStatus("telegram-status", "down", "Unreachable");
      setText("tg-info", "Network error");
      return false;
    }
  }

  async function loadStats() {
    try {
      var prods = await db.collection("products").get();
      stats.products = prods.size;

      var users = await db.collection("users").get();
      stats.users = users.size;
      var ONLINE_WINDOW = 2 * 60 * 1000;
      var online = 0;
      users.forEach(function (u) {
        if (u.data().lastSeen && u.data().lastSeen.toDate) {
          if (Date.now() - u.data().lastSeen.toDate().getTime() < ONLINE_WINDOW) online++;
        }
      });
      stats.online = online;

      var orders = await db.collection("orders").get();
      stats.orders = orders.size;

      var blocks = await db.collection("blockedDevices").get();
      stats.blocks = blocks.size;

      setText("metric-products", stats.products);
      setText("metric-users", stats.users);
      setText("metric-orders", stats.orders);
      setText("metric-online", stats.online);
      setText("ban-count", stats.blocks);
      setText("overall-orders", stats.orders);
    } catch (e) {
      console.warn("loadStats failed:", e);
    }
  }

  async function loadRecentActivity() {
    var tbody = $("#activity-tbody");
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px; color: var(--text-dim);">Loading...</td></tr>';

    try {
      var orders = await db.collection("orders").orderBy("createdAt", "desc").limit(5).get();
      var events = [];
      orders.forEach(function (d) {
        var data = d.data();
        events.push({
          ts: data.createdAt ? data.createdAt.toDate() : new Date(),
          service: "Orders",
          event: "New order: " + (data.productTitle || "—").slice(0, 30),
          status: data.status || "pending"
        });
      });

      var audit = await db.collection("config").doc("auditLog").collection("entries").orderBy("ts", "desc").limit(3).get();
      audit.forEach(function (d) {
        var data = d.data();
        if (data.ts && data.ts.toDate) {
          events.push({
            ts: data.ts.toDate(),
            service: "Admin",
            event: (data.action || "—") + " by " + (data.email || "—").split("@")[0],
            status: "info"
          });
        }
      });

      events.sort(function (a, b) { return b.ts - a.ts; });
      var recent = events.slice(0, 8);

      if (!recent.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px; color: var(--text-dim);">No recent activity.</td></tr>';
        return;
      }

      tbody.innerHTML = "";
      recent.forEach(function (e) {
        var tr = document.createElement("tr");
        var statusClass = "info";
        if (e.status === "completed") statusClass = "success";
        else if (e.status === "cancelled") statusClass = "danger";
        else if (e.status === "pending" || e.status === "contacted") statusClass = "warn";
        tr.innerHTML =
          '<td style="color:var(--text-dim); font-size:0.85rem; white-space:nowrap;">' + formatRelative(e.ts) + '</td>' +
          '<td><span class="badge-soft">' + e.service + '</span></td>' +
          '<td style="word-break:break-word;">' + e.event + '</td>' +
          '<td><span class="badge-soft ' + statusClass + '">' + e.status + '</span></td>';
        tbody.appendChild(tr);
      });
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px; color: var(--text-dim);">Activity feed unavailable.</td></tr>';
    }
  }

  async function checkMaintenance() {
    try {
      var doc = await db.collection("config").doc("maintenance").get();
      if (doc.exists && doc.data().enabled === true) {
        setText("status-text", "Maintenance");
        $("#status-badge").className = "status-badge warn";
        $("#status-dot").style.background = "var(--warn)";
        $("#status-dot").style.boxShadow = "0 0 12px var(--warn)";
      }
    } catch (e) { /* */ }
  }

  async function updateOverall() {
    var allGood = true;
    allGood = (await testDatabase()) >= 0 && allGood;
    allGood = (await testAuth()) && allGood;
    allGood = (await testTelegram()) && allGood;

    var badge = $("#status-badge");
    var dot = $("#status-dot");
    var text = $("#status-text");
    if (allGood) {
      badge.className = "status-badge ok";
      dot.style.background = "var(--accent)";
      dot.style.boxShadow = "0 0 12px var(--accent)";
      text.textContent = "All Systems Operational";
    } else {
      badge.className = "status-badge warn";
      dot.style.background = "var(--warn)";
      dot.style.boxShadow = "0 0 12px var(--warn)";
      text.textContent = "Partial Outage";
    }
  }

  function updateTimestamp() {
    setText("last-updated", new Date().toLocaleTimeString());
  }

  function attachNav() {
    var toggle = $("#nav-toggle");
    var links = $("#nav-links");
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
          document.body.style.overflow = "";
        });
      });
    }
    var btt = $("#back-to-top");
    if (btt) {
      window.addEventListener("scroll", function () {
        if (window.scrollY > 400) btt.classList.add("visible");
        else btt.classList.remove("visible");
      }, { passive: true });
      btt.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
    }
  }

  async function refresh() {
    updateTimestamp();
    await updateOverall();
    await loadStats();
    await loadRecentActivity();
    await checkMaintenance();
  }

  function init() {
    attachNav();
    refresh();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, REFRESH_INTERVAL);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
