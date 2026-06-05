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
      window.db.settings({ ignoreUndefinedProperties: true }, { merge: true });
    } catch (e) { /* settings only allowed once */ }
  }

  window.COLLECTIONS = {
    PRODUCTS: "products",
    BLOCKED: "blockedDevices",
    USERS: "users",
    ORDERS: "orders",
    CONFIG: "config",
    VISITORS: "visitors",
    PAYMENT_METHODS: "paymentMethods",
    COUPONS: "coupons"
  };

  window.PAYMENT_DEFAULTS = [
    { id: "vodafone-cash", name: "Vodafone Cash", type: "mobile_wallet", icon: "📱", color: "#e60000", accountNumber: "", accountName: "", instructions: "Transfer the total amount to this number, then enter the transaction ID below.", enabled: false, sortOrder: 1 },
    { id: "etisalat-cash", name: "Etisalat Cash", type: "mobile_wallet", icon: "💸", color: "#76b900", accountNumber: "", accountName: "", instructions: "Transfer the total amount, then enter the transaction reference below.", enabled: false, sortOrder: 2 },
    { id: "we-cash", name: "WE Cash", type: "mobile_wallet", icon: "💳", color: "#621d6a", accountNumber: "", accountName: "", instructions: "Send the amount via WE Pay, then enter the transaction ID.", enabled: false, sortOrder: 3 },
    { id: "fawry", name: "Fawry", type: "gateway", icon: "🧾", color: "#f37321", accountNumber: "", accountName: "", instructions: "Pay at any Fawry outlet or use the Fawry app with the reference code provided.", enabled: false, sortOrder: 4 }
  ];

  window.COUPON_DEFAULTS = [
    { code: "WELCOME10", type: "percentage", value: 10, minOrderAmount: 0, maxUses: null, description: "Welcome 10% off your first order", enabled: true, validDays: 365 },
    { code: "SAVE20", type: "percentage", value: 20, minOrderAmount: 200, maxUses: 100, description: "20% off orders over 200 EGP (first 100 customers)", enabled: true, validDays: 30 },
    { code: "FLAT50", type: "fixed", value: 50, minOrderAmount: 300, maxUses: null, description: "Flat 50 EGP off orders over 300 EGP", enabled: true, validDays: 60 }
  ];

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
    VISITOR_LOG_THROTTLE_MS: 10000,
    ALERTS_ENABLED: true
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
