(function () {
  "use strict";

  function generateInvoiceId() {
    var ts = new Date().getTime().toString(36).toUpperCase();
    var rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return "INV-" + ts + "-" + rand;
  }

  function fmtDate(d) {
    if (!d) d = new Date();
    if (typeof d === "object" && d.toDate) d = d.toDate();
    var date = d instanceof Date ? d : new Date(d);
    return date.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
  }

  function fmtDateTime(d) {
    if (!d) d = new Date();
    if (typeof d === "object" && d.toDate) d = d.toDate();
    var date = d instanceof Date ? d : new Date(d);
    return date.toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function fmtMoney(n) {
    return Number(n || 0).toFixed(2) + " EGP";
  }

  function truncate(str, max) {
    str = String(str || "");
    return str.length > max ? str.substring(0, max - 1) + "…" : str;
  }

  function sanitizeText(str, max) {
    var s = String(str == null ? "" : str)
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim();
    if (max && s.length > max) s = s.substring(0, max);
    return s;
  }

  function getJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
    if (window.jsPDF) return window.jsPDF;
    return null;
  }

  function buildInvoice(order) {
    var jsPDFCtor = getJsPDF();
    if (!jsPDFCtor) {
      console.warn("[SynaxMatrix] jsPDF not loaded");
      return null;
    }

    var doc = new jsPDFCtor({ unit: "mm", format: "a4" });
    var invoiceId = sanitizeText(order.invoiceId, 50) || generateInvoiceId();
    var date = order.createdAt ? new Date(order.createdAt) : new Date();

    var CYAN = [0, 200, 220];
    var DARK = [10, 10, 24];
    var TEXT = [30, 30, 50];
    var MUTED = [120, 130, 150];
    var LINE = [220, 225, 235];
    var BG = [248, 250, 252];

    doc.setFillColor.apply(doc, DARK);
    doc.rect(0, 0, 210, 38, "F");

    doc.setFillColor.apply(doc, CYAN);
    doc.rect(0, 38, 210, 1.2, "F");

    doc.setTextColor.apply(doc, CYAN);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.text("SYNAXMATRIX", 15, 17);

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(180, 200, 220);
    doc.text("// SERVICES", 15, 24);

    doc.setFontSize(7.5);
    doc.setTextColor(150, 170, 190);
    doc.text("Next-Gen Digital Services · Established 2026", 15, 30);

    doc.setTextColor.apply(doc, CYAN);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(24);
    doc.text("INVOICE", 195, 17, { align: "right" });

    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(180, 200, 220);
    doc.text("INVOICE #", 195, 24, { align: "right" });
    doc.setFont("helvetica", "bold");
    doc.setTextColor.apply(doc, CYAN);
    doc.setFontSize(9);
    doc.text(invoiceId, 195, 30, { align: "right" });

    doc.setTextColor.apply(doc, TEXT);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, CYAN);
    doc.text("BILL TO", 15, 55);
    doc.setDrawColor.apply(doc, CYAN);
    doc.setLineWidth(0.4);
    doc.line(15, 57, 42, 57);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor.apply(doc, TEXT);
    doc.text(sanitizeText(order.customerName, 60) || "—", 15, 64);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor.apply(doc, MUTED);
    if (order.customerEmail) doc.text(sanitizeText(order.customerEmail, 60), 15, 70);
    if (order.customerPhone) doc.text(sanitizeText(order.customerPhone, 30), 15, 75);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, CYAN);
    doc.text("INVOICE DETAILS", 125, 55);
    doc.setDrawColor.apply(doc, CYAN);
    doc.line(125, 57, 165, 57);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Issued:", 125, 64);
    doc.setTextColor.apply(doc, TEXT);
    doc.text(fmtDate(date), 148, 64);

    doc.setTextColor.apply(doc, MUTED);
    doc.text("Order ID:", 125, 70);
    doc.setTextColor.apply(doc, TEXT);
    doc.setFont("courier", "normal");
    doc.setFontSize(7.5);
    doc.text(sanitizeText(order.id, 22), 148, 70);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Status:", 125, 76);
    doc.setTextColor.apply(doc, MUTED);
    var statusLabel = (order.status || "pending").toUpperCase();
    doc.text(statusLabel, 148, 76);

    var tableY = 95;
    doc.setFillColor.apply(doc, DARK);
    doc.rect(15, tableY, 180, 9, "F");

    doc.setTextColor.apply(doc, CYAN);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.text("DESCRIPTION", 18, tableY + 6);
    doc.text("QTY", 145, tableY + 6);
    doc.text("AMOUNT", 192, tableY + 6, { align: "right" });

    var rowY = tableY + 22;
    doc.setTextColor.apply(doc, TEXT);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    var title = sanitizeText(order.productTitle, 55) || "Service";
    doc.text(title, 18, rowY);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Digital service / product", 18, rowY + 5);

    if (order.productCategory) {
      doc.setFontSize(7.5);
      doc.text("Category: " + sanitizeText(order.productCategory, 30), 18, rowY + 10);
    }

    doc.setTextColor.apply(doc, TEXT);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text("1", 145, rowY);

    var priceStr = fmtMoney(order.productPrice);
    doc.setFont("helvetica", "bold");
    doc.text(priceStr, 192, rowY, { align: "right" });

    doc.setDrawColor.apply(doc, LINE);
    doc.setLineWidth(0.3);
    doc.line(15, rowY + 16, 195, rowY + 16);

    var totalY = rowY + 28;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Subtotal", 145, totalY);
    doc.text(priceStr, 192, totalY, { align: "right" });

    doc.text("Tax (0%)", 145, totalY + 6);
    doc.text("0.00 EGP", 192, totalY + 6, { align: "right" });

    doc.setFillColor.apply(doc, BG);
    doc.rect(140, totalY + 11, 55, 12, "F");
    doc.setDrawColor.apply(doc, CYAN);
    doc.setLineWidth(0.5);
    doc.rect(140, totalY + 11, 55, 12);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor.apply(doc, DARK);
    doc.text("TOTAL", 145, totalY + 19);
    doc.setFontSize(13);
    doc.setTextColor.apply(doc, CYAN);
    doc.text(priceStr, 192, totalY + 19, { align: "right" });

    var thanksY = totalY + 38;
    doc.setFillColor.apply(doc, BG);
    doc.roundedRect(15, thanksY, 180, 22, 2, 2, "F");
    doc.setDrawColor.apply(doc, CYAN);
    doc.setLineWidth(0.5);
    doc.roundedRect(15, thanksY, 180, 22, 2, 2, "S");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor.apply(doc, DARK);
    doc.text("Thank you for your business!", 105, thanksY + 8, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("We appreciate your trust in SynaxMatrix.", 105, thanksY + 14, { align: "center" });
    doc.setFontSize(7.5);
    doc.text("Your order will be processed shortly — we'll contact you via phone or email.", 105, thanksY + 18, { align: "center" });

    doc.setDrawColor.apply(doc, LINE);
    doc.setLineWidth(0.3);
    doc.line(15, 270, 195, 270);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("SYNAXMATRIX SERVICES", 15, 276);
    doc.setFontSize(7);
    doc.setTextColor(150, 160, 175);
    doc.text("ya2190069@gmail.com", 15, 281);

    doc.setFontSize(7);
    doc.setTextColor(150, 160, 175);
    doc.text("Invoice generated: " + fmtDateTime(new Date()), 195, 276, { align: "right" });
    doc.text("Page 1 of 1", 195, 281, { align: "right" });

    return {
      invoiceId: invoiceId,
      doc: doc,
      filename: "SynaxMatrix-" + invoiceId + ".pdf",
      blob: doc.output("blob"),
      dataUrl: doc.output("datauristring"),
      summary: {
        invoiceId: invoiceId,
        customer: sanitizeText(order.customerName, 60),
        product: title,
        price: priceStr,
        date: fmtDate(date),
        orderId: order.id
      }
    };
  }

  function triggerDownload(invoice) {
    if (!invoice || !invoice.blob) return;
    try {
      var url = URL.createObjectURL(invoice.blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = invoice.filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 200);
      return true;
    } catch (e) {
      console.warn("Download trigger failed:", e);
      return false;
    }
  }

  window.SynaxInvoice = {
    generate: buildInvoice,
    generateId: generateInvoiceId,
    download: triggerDownload
  };
})();
