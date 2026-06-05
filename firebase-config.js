(function () {
  "use strict";

  var firebaseConfig = {
    apiKey: "AIzaSyBai4Td_6CGRBW94EMoP-FRJtUCD2wodA4",
    authDomain: "my-brand-f6374.firebaseapp.com",
    projectId: "my-brand-f6374",
    storageBucket: "my-brand-f6374.firebasestorage.app",
    messagingSenderId: "481348404498",
    appId: "1:481348404498:web:41108b0da611fcba61dfcb"
  };

  if (typeof firebase === "undefined") {
    console.error("[SynaxMatrix] Firebase SDK not loaded");
    return;
  }

  try {
    firebase.initializeApp(firebaseConfig);
  } catch (e) {
    if (!/already exists/.test(e.message)) {
      console.error("[SynaxMatrix] Firebase init failed:", e);
    }
  }

  window.auth = firebase.auth();
  window.db = firebase.firestore();

  if (window.db && window.db.settings) {
    try {
      window.db.settings({ experimentalForceLongPolling: false, ignoreUndefinedProperties: true });
    } catch (e) { /* settings only allowed once */ }
  }

  window.COLLECTIONS = {
    PRODUCTS: "products",
    BLOCKED: "blockedDevices",
    USERS: "users",
    ORDERS: "orders",
    CONFIG: "config",
    VISITORS: "visitors"
  };

  window.OWNER_EMAIL = "ya2190069@gmail.com";

  window.isOwner = function (user) {
    if (!user || !user.email) return false;
    return user.email.toLowerCase() === window.OWNER_EMAIL.toLowerCase();
  };

  window.CURRENCY = {
    code: "EGP",
    symbol: "ج.م",
    format: function (n) { return Number(n || 0).toFixed(2) + " ج.م"; }
  };

  window.SECURITY = {
    ORDER_COOLDOWN_MS: 60000,
    MAX_LOGIN_ATTEMPTS: 5,
    LOGIN_LOCKOUT_MS: 60000,
    VISITOR_LOG_THROTTLE_MS: 10000
  };

  window.MAINTENANCE_DEFAULT = {
    enabled: false,
    message: "We're performing scheduled maintenance to improve your experience. We'll be back shortly. Thank you for your patience.",
    eta: null,
    etaText: "Soon",
    updatedAt: null,
    updatedBy: null
  };
})();
