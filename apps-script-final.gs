const CONFIG = {
  SHEET_NAME: "Monthly",
  SEARCH_QUERY: "invoice OR factura OR remision has:attachment",
  MAX_EMAILS: 50
};

function processInvoiceEmails() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEET_NAME);
  
  const processed = getProcessedIds();
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, CONFIG.MAX_EMAILS);
  let count = 0;

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const id = msg.getId();
      if (processed.has(id)) continue;

      const text = msg.getSubject() + "\n" + msg.getPlainBody();
      const from = msg.getFrom();
      const date = msg.getDate();

      const row = [
        extractDate(text, date),
        extractInvoiceNumber(text),
        extractVendor(from, text),
        extractAmount(text),
        extractIVA(text),
        extractBase(text),
        classifyCategory(text),
        "EUR",
        "From Gmail",
        "",
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm")
      ];

      sheet.appendRow(row);
      saveProcessedId(id);
      count++;
    }
  }

  SpreadsheetApp.getUi().alert("Complete: " + count + " invoices added");
}

// Extract invoice number
function extractInvoiceNumber(text) {
  const patterns = [
    /invoice\s*(?:#|no\.?|num\.?)?\s*[:\-]?\s*([A-Z0-9\-\/]+)/i,
    /factura\s*(?:n[ou]\.?|numero)?\s*[:\-]?\s*([A-Z0-9\-\/]+)/i,
    /(?:inv|fac)\s*[-_]?(\d{3,})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return "";
}

// Extract vendor name
function extractVendor(from, text) {
  const nameMatch = from.match(/^"?([^"<@\n]{2,})"?\s*</);
  if (nameMatch) return nameMatch[1].trim();

  const bodyMatch = text.match(
    /(?:from|de|vendor|supplier)\s*[:\-]\s*(.+?)(?:\n|$)/i
  );
  if (bodyMatch) return bodyMatch[1].trim();

  return from.replace(/<.*>/, '').trim();
}

// Extract date
function extractDate(text, fallback) {
  const patterns = [
    /(?:date|fecha|issued)\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    /(\d{4})[\/\-\.](\d{2})[\/\-\.](\d{2})/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return Utilities.formatDate(fallback, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// Extract total amount
function extractAmount(text) {
  const patterns = [
    /(?:total|amount|importe)\s*[:\-]?\s*[€$£]?\s*([\d,\.]+)/i,
    /[€$£]\s*([\d,\.]+)/,
    /([\d,\.]+)\s*(?:EUR|USD|GBP)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ''));
      return num || m[1];
    }
  }
  return 0;
}

// Extract IVA
function extractIVA(text) {
  const m = text.match(
    /(?:IVA|VAT|tax)\s*(?:\d+%\s*)?[:\-]?\s*[€$£]?\s*([\d,\.]+)/i
  );
  return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
}

// Extract base amount
function extractBase(text) {
  const m = text.match(
    /(?:base|subtotal)\s*[:\-]?\s*[€$£]?\s*([\d,\.]+)/i
  );
  return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
}

// Classify category
function classifyCategory(text) {
  const t = text.toLowerCase();
  const map = {
    "Meals & Entertainment": ["restaurant", "food", "meal", "cafe", "comida", "comida", "carne", "meat"],
    "Office Supplies": ["office", "stationery", "supplies"],
    "Transportation": ["taxi", "uber", "transport", "shipping"],
    "Software": ["software", "subscription", "saas", "license"],
    "Utilities": ["electricity", "internet", "phone", "utility"],
  };
  for (const [cat, keys] of Object.entries(map)) {
    if (keys.some(k => t.includes(k))) return cat;
  }
  return "Other";
}

// Get processed email IDs
function getProcessedIds() {
  const raw = PropertiesService.getScriptProperties()
    .getProperty('ids') || '[]';
  return new Set(JSON.parse(raw));
}

// Save processed email ID
function saveProcessedId(id) {
  const props = PropertiesService.getScriptProperties();
  const ids = JSON.parse(props.getProperty('ids') || '[]');
  ids.push(id);
  if (ids.length > 1000) ids.splice(0, ids.length - 1000);
  props.setProperty('ids', JSON.stringify(ids));
}

// Create daily trigger
function createDailyTrigger() {
  ScriptApp.newTrigger('processInvoiceEmails')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();
  SpreadsheetApp.getUi().alert('Daily trigger set: 8 AM');
}

// Test function
function testScript() {
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 1);
  if (threads.length > 0) {
    const msg = threads[0].getMessages()[0];
    const text = msg.getSubject() + "\n" + msg.getPlainBody();
    
    Logger.log("Subject: " + msg.getSubject());
    Logger.log("Invoice #: " + extractInvoiceNumber(text));
    Logger.log("Vendor: " + extractVendor(msg.getFrom(), text));
    Logger.log("Amount: " + extractAmount(text));
    Logger.log("IVA: " + extractIVA(text));
    Logger.log("Category: " + classifyCategory(text));
  }
}
