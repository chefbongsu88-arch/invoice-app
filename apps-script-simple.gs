/**
 * Google Apps Script for Invoice Automation
 * Simplified version - Gmail to Google Sheets
 */

const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
const GEMINI_API_KEY = "AIzaSyDwzgFUpbnMBcd1n1Dg-Ck3mncYHhvzWW0";

// Invoice keywords
const INVOICE_KEYWORDS = [
  "factura", "remisión", "ticket", "importe", "total", "fecha", "empresa", "iva", "concepto",
  "invoice", "receipt", "amount", "date", "company", "tax", "description"
];

const EXCLUDE_KEYWORDS = [
  "confirmación de pago", "payment confirmation", "fwd:", "forwarded", "recibido", "received"
];

/**
 * Main function - process Gmail invoices
 */
function processGmailInvoices() {
  Logger.log("Starting Gmail invoice processing...");
  
  try {
    const query = "is:unread newer_than:1d";
    const threads = GmailApp.search(query);
    
    Logger.log("Found " + threads.length + " unread emails");
    
    for (let i = 0; i < threads.length; i++) {
      const messages = threads[i].getMessages();
      for (let j = 0; j < messages.length; j++) {
        processMessage(messages[j]);
      }
    }
    
    Logger.log("Processing completed");
  } catch (error) {
    Logger.log("Error: " + error);
  }
}

/**
 * Process single email
 */
function processMessage(message) {
  const subject = message.getSubject();
  const body = message.getPlainBody();
  const sender = message.getFrom();
  
  Logger.log("Processing: " + subject);
  
  if (!isInvoiceEmail(subject, body)) {
    Logger.log("Not an invoice email");
    return;
  }
  
  Logger.log("Detected as invoice");
  
  const invoiceData = extractInvoiceData(message);
  if (invoiceData) {
    if (!isDuplicate(invoiceData)) {
      addToSheet(invoiceData);
      Logger.log("Added: " + invoiceData.vendor);
    } else {
      Logger.log("Duplicate found");
    }
  }
}

/**
 * Check if email is invoice
 */
function isInvoiceEmail(subject, body) {
  const text = (subject + " " + body).toLowerCase();
  
  // Check exclude keywords
  for (let i = 0; i < EXCLUDE_KEYWORDS.length; i++) {
    if (text.indexOf(EXCLUDE_KEYWORDS[i].toLowerCase()) > -1) {
      return false;
    }
  }
  
  // Check invoice keywords
  for (let i = 0; i < INVOICE_KEYWORDS.length; i++) {
    if (text.indexOf(INVOICE_KEYWORDS[i].toLowerCase()) > -1) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract invoice data using Gemini AI
 */
function extractInvoiceData(message) {
  try {
    const subject = message.getSubject();
    const body = message.getPlainBody();
    
    const emailContent = "Subject: " + subject + "\n\nBody:\n" + body;
    
    const extractedData = callGeminiAPI(emailContent);
    
    if (extractedData) {
      return {
        source: "Gmail",
        invoiceNumber: extractedData.invoiceNumber || "",
        vendor: extractedData.vendor || "",
        date: extractedData.date || new Date().toISOString().split('T')[0],
        totalAmount: extractedData.totalAmount || 0,
        ivaAmount: extractedData.ivaAmount || 0,
        baseAmount: extractedData.baseAmount || 0,
        category: extractedData.category || "Other",
        currency: extractedData.currency || "EUR",
        notes: "From: " + message.getFrom(),
        imageUrl: ""
      };
    }
  } catch (error) {
    Logger.log("Error extracting data: " + error);
  }
  
  return null;
}

/**
 * Call Gemini API
 */
function callGeminiAPI(emailContent) {
  try {
    const prompt = "Extract invoice info from this email. Return JSON: {invoiceNumber, vendor, date (YYYY-MM-DD), totalAmount (number), ivaAmount (number), baseAmount (number), category (Meals or Other), currency}. Email: " + emailContent;
    
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + GEMINI_API_KEY;
    
    const payload = {
      contents: [{
        parts: [{
          text: prompt
        }]
      }]
    };
    
    const options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    
    if (result.candidates && result.candidates[0] && result.candidates[0].content) {
      const text = result.candidates[0].content.parts[0].text;
      
      // Extract JSON
      const startIdx = text.indexOf('{');
      const endIdx = text.lastIndexOf('}');
      
      if (startIdx > -1 && endIdx > -1) {
        const jsonStr = text.substring(startIdx, endIdx + 1);
        return JSON.parse(jsonStr);
      }
    }
  } catch (error) {
    Logger.log("Gemini API error: " + error);
  }
  
  return null;
}

/**
 * Check for duplicates
 */
function isDuplicate(invoiceData) {
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("Monthly");
    if (!sheet) return false;
    
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      
      if (invoiceData.invoiceNumber && row[1] === invoiceData.invoiceNumber) {
        return true;
      }
      
      if (row[2] === invoiceData.vendor && 
          row[3] === invoiceData.totalAmount && 
          row[4] === invoiceData.date) {
        return true;
      }
    }
  } catch (error) {
    Logger.log("Duplicate check error: " + error);
  }
  
  return false;
}

/**
 * Add to Google Sheets
 */
function addToSheet(invoiceData) {
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("Monthly");
    if (!sheet) {
      Logger.log("Sheet not found");
      return;
    }
    
    const newRow = [
      invoiceData.date,
      invoiceData.invoiceNumber,
      invoiceData.vendor,
      invoiceData.totalAmount,
      invoiceData.ivaAmount,
      invoiceData.baseAmount,
      invoiceData.category,
      invoiceData.currency,
      invoiceData.notes,
      invoiceData.imageUrl,
      new Date().toISOString()
    ];
    
    sheet.appendRow(newRow);
    Logger.log("Row added");
  } catch (error) {
    Logger.log("Error adding to sheet: " + error);
  }
}

/**
 * Set up trigger (run once)
 */
function setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  
  ScriptApp.newTrigger("processGmailInvoices")
    .timeBased()
    .everyHours(1)
    .create();
  
  Logger.log("Trigger setup complete");
}

/**
 * Test function
 */
function testScript() {
  Logger.log("Testing...");
  
  const threads = GmailApp.search("", 0, 1);
  if (threads.length > 0) {
    const message = threads[0].getMessages()[0];
    Logger.log("Email: " + message.getSubject());
    
    if (isInvoiceEmail(message.getSubject(), message.getPlainBody())) {
      Logger.log("Invoice detected");
      const data = extractInvoiceData(message);
      Logger.log("Data: " + JSON.stringify(data));
    } else {
      Logger.log("Not an invoice");
    }
  }
}
