/**
 * Google Apps Script for Invoice Automation
 * Extracts invoices from Gmail and automatically adds them to Google Sheets
 * 
 * Setup:
 * 1. Open Google Sheets
 * 2. Extensions → Apps Script
 * 3. Replace code.gs with this script
 * 4. Update SPREADSHEET_ID and GEMINI_API_KEY below
 * 5. Run setupTrigger() to enable automatic execution
 */

// Configuration
const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
const GEMINI_API_KEY = "AIzaSyDwzgFUpbnMBcd1n1Dg-Ck3mncYHhvzWW0";

// Invoice keywords (Spanish + English)
const INVOICE_KEYWORDS = {
  spanish: ["factura", "remisión", "ticket", "importe", "total", "fecha", "empresa", "iva", "concepto"],
  english: ["invoice", "receipt", "amount", "total", "date", "company", "tax", "description"]
};

// Exclude keywords (not invoices)
const EXCLUDE_KEYWORDS = ["confirmación de pago", "payment confirmation", "fwd:", "forwarded", "recibido", "received"];

/**
 * Main function to process Gmail invoices
 * Run this manually or set up a trigger to run automatically
 */
function processGmailInvoices() {
  Logger.log("Starting Gmail invoice processing...");
  
  try {
    // Get unread emails from last 24 hours
    const query = "is:unread newer_than:1d";
    const threads = GmailApp.search(query);
    
    Logger.log(`Found ${threads.length} unread emails`);
    
    for (const thread of threads) {
      const messages = thread.getMessages();
      
      for (const message of messages) {
        processMessage(message);
      }
    }
    
    Logger.log("Gmail invoice processing completed");
  } catch (error) {
    Logger.log(`Error: ${error}`);
  }
}

/**
 * Process individual email message
 */
function processMessage(message) {
  const subject = message.getSubject();
  const body = message.getPlainBody();
  const sender = message.getFrom();
  
  Logger.log(`Processing: ${subject} from ${sender}`);
  
  // Check if this is an invoice email
  if (!isInvoiceEmail(subject, body)) {
    Logger.log("Not an invoice email, skipping");
    return;
  }
  
  Logger.log("Detected as invoice email");
  
  // Extract invoice data
  const invoiceData = extractInvoiceData(message);
  
  if (invoiceData) {
    // Check for duplicates
    if (!isDuplicate(invoiceData)) {
      // Add to Google Sheets
      addToSheet(invoiceData);
      Logger.log(`Added invoice: ${invoiceData.vendor} - ${invoiceData.totalAmount}`);
    } else {
      Logger.log("Duplicate invoice, skipping");
    }
  }
}

/**
 * Check if email is an invoice
 */
function isInvoiceEmail(subject, body) {
  const text = (subject + " " + body).toLowerCase();
  
  // Check for exclude keywords first
  for (const keyword of EXCLUDE_KEYWORDS) {
    if (text.includes(keyword.toLowerCase())) {
      return false;
    }
  }
  
  // Check for invoice keywords
  const allKeywords = [...INVOICE_KEYWORDS.spanish, ...INVOICE_KEYWORDS.english];
  for (const keyword of allKeywords) {
    if (text.includes(keyword.toLowerCase())) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract invoice data from email using Gemini AI
 */
function extractInvoiceData(message) {
  try {
    const subject = message.getSubject();
    const body = message.getPlainBody();
    const attachments = message.getAttachments();
    
    // Prepare email content for AI
    let emailContent = `Subject: ${subject}\n\nBody:\n${body}`;
    
    // Add attachment info
    if (attachments.length > 0) {
      emailContent += `\n\nAttachments: ${attachments.map(a => a.getName()).join(", ")}`;
    }
    
    // Call Gemini API to extract invoice data
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
        notes: extractedData.notes || `From: ${message.getFrom()}`,
        imageUrl: ""
      };
    }
  } catch (error) {
    Logger.log(`Error extracting invoice data: ${error}`);
  }
  
  return null;
}

/**
 * Call Gemini API to parse invoice data
 */
function callGeminiAPI(emailContent) {
  try {
    const prompt = `
Extract invoice information from this email. Return JSON format:
{
  "invoiceNumber": "invoice number or empty",
  "vendor": "company/vendor name",
  "date": "YYYY-MM-DD format",
  "totalAmount": number,
  "ivaAmount": number,
  "baseAmount": number,
  "category": "Meals & Entertainment or Other",
  "currency": "EUR or other"
}

Email content:
${emailContent}

Return only valid JSON, no other text.
`;

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
      
      // Extract JSON from response
      try {
        // Find JSON object in response
        const startIdx = text.indexOf('{');
        const endIdx = text.lastIndexOf('}');
        if (startIdx !== -1 && endIdx !== -1) {
          const jsonStr = text.substring(startIdx, endIdx + 1);
          return JSON.parse(jsonStr);
        }
      } catch (e) {
        Logger.log('JSON parse error: ' + e);
      }
    }
  } catch (error) {
    Logger.log(`Gemini API error: ${error}`);
  }
  
  return null;
}

/**
 * Check if invoice already exists (duplicate detection)
 */
function isDuplicate(invoiceData) {
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("Monthly");
    if (!sheet) return false;
    
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      
      // Check by invoice number
      if (invoiceData.invoiceNumber && row[1] === invoiceData.invoiceNumber) {
        return true;
      }
      
      // Check by vendor + amount + date
      if (row[2] === invoiceData.vendor && 
          row[3] === invoiceData.totalAmount && 
          row[4] === invoiceData.date) {
        return true;
      }
    }
  } catch (error) {
    Logger.log(`Duplicate check error: ${error}`);
  }
  
  return false;
}

/**
 * Add invoice to Google Sheets
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
    Logger.log("Row added to sheet");
  } catch (error) {
    Logger.log(`Error adding to sheet: ${error}`);
  }
}

/**
 * Set up automatic trigger (run this once)
 */
function setupTrigger() {
  // Remove existing triggers
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    ScriptApp.deleteTrigger(trigger);
  }
  
  // Create new trigger: run every hour
  ScriptApp.newTrigger("processGmailInvoices")
    .timeBased()
    .everyHours(1)
    .create();
  
  Logger.log("Trigger set up: processGmailInvoices will run every hour");
}

/**
 * Test function
 */
function testScript() {
  Logger.log("Testing Gmail invoice script...");
  
  // Get most recent email
  const threads = GmailApp.search("", 0, 1);
  if (threads.length > 0) {
    const message = threads[0].getMessages()[0];
    Logger.log(`Test email: ${message.getSubject()}`);
    
    if (isInvoiceEmail(message.getSubject(), message.getPlainBody())) {
      Logger.log("✓ Detected as invoice email");
      const data = extractInvoiceData(message);
      Logger.log("Extracted data: " + JSON.stringify(data));
    } else {
      Logger.log("✗ Not detected as invoice email");
    }
  }
}
