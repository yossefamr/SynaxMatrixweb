(function () {
  "use strict";

  var POLL_INTERVAL = 30000;
  var pollTimer = null;
  var progress = 0;
  var progressTimer = null;

  function $(sel) { return document.querySelector(sel); }

  function showAdminLink() {
    if (typeof auth === "undefined" || !auth) return;
    auth.onAuthStateChanged(function (user) {
      if (user && typeof isAdminEmail === "function" && isAdminEmail(user.email)) {
        var link = $("#admin-link");
        if (link) link.style.display = "inline-flex";
      }
    });
  }

  function updateProgress() {
    progress += Math.random() * 8;
    if (progress > 95) progress = 95;
    var fill = $("#progress-fill");
    var text = $("#progress-text");
    if (fill) fill.style.width = Math.min(progress, 100) + "%";
    var messages = [
      "Analyzing systems...",
      "Optimizing database queries...",
      "Patching security layers...",
      "Running diagnostics...",
      "Backing up user data...",
      "Updating AI models...",
      "Finalizing improvements..."
    ];
    if (text) text.textContent = messages[Math.floor((Date.now() / 2000) % messages.length)];
  }

  function updateEtaText(data) {
    var etaEl = $("#m-stat-uptime");
    if (!etaEl) return;
    if (data && data.eta) {
      var eta = new Date(data.eta);
      if (!isNaN(eta.getTime())) {
        var diff = eta.getTime() - Date.now();
        if (diff <= 0) { etaEl.textContent = "Any moment"; return; }
        var mins = Math.floor(diff / 60000);
        if (mins < 60) etaEl.textContent = mins + "m";
        else etaEl.textContent = Math.floor(mins / 60) + "h " + (mins % 60) + "m";
        return;
      }
    }
    etaEl.textContent = (data && data.etaText) || "Soon";
  }

  function updateMessage(data) {
    if (!data) return;
    if (data.message) {
      var msgEl = $("#maintenance-message");
      if (msgEl) msgEl.textContent = data.message;
    }
  }

  function checkMaintenance() {
    if (typeof db === "undefined") return;
    db.collection("config").doc("maintenance").get().then(function (snap) {
      var statusEl = $("#m-stat-status");
      var data = snap.exists ? (snap.data() || {}) : null;
      if (!data || data.enabled !== true) {
        if (statusEl) { statusEl.textContent = "✓"; statusEl.style.color = "var(--accent)"; }
        progress = 100;
        var fill = $("#progress-fill");
        if (fill) fill.style.width = "100%";
        var text = $("#progress-text");
        if (text) text.textContent = "System back online — redirecting...";
        setTimeout(function () { window.location.href = "index.html"; }, 1500);
        return;
      }
      if (statusEl) { statusEl.textContent = "●"; statusEl.style.color = "var(--warn)"; }
      updateEtaText(data);
      updateMessage(data);
    }).catch(function () {
      var statusEl = $("#m-stat-status");
      if (statusEl) { statusEl.textContent = "?"; statusEl.style.color = "var(--text-muted)"; }
    });
  }

  function init() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(updateProgress, 2000);
    updateProgress();

    showAdminLink();
    checkMaintenance();

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(checkMaintenance, POLL_INTERVAL);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
