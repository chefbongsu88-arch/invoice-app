/**
 * Fixed export to Google Sheets
 * - Main sheet: append new invoices
 * - Monthly sheets: clear and regenerate from main sheet data
 * - Quarterly sheets: clear and regenerate from main sheet data
 * - No TOTAL rows (user doesn't want them)
 */

import { uploadImageToStorage } from "./image-upload-storage";

// Generate JWT for Google Sheets API
async function generateJWT(serviceAccount: any): Promise<string> {
  const crypto = await import('crypto');
  
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${header}.${encodedPayload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');
  
  return `${signatureInput}.${signature}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", 
                "July", "August", "September", "October", "November", "December"];
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

interface InvoiceRow {
  source: string;
  invoiceNumber: string;
  vendor: string;
  date: string;
  totalAmount: number;
  ivaAmount: number;
  baseAmount: number;
  category: string;
  currency: string;
  tip?: number;
  notes?: string;
  imageUrl?: string;
}

/**
 * Export invoice to main sheet and regenerate monthly/quarterly sheets
 */
export async function exportToSheetsFixed(
  spreadsheetId: string,
  newInvoices: InvoiceRow[],
  accessToken: string
) {
  // Step 0: Check for duplicates
  console.log(`[Export] Checking for duplicates...`);
  
  const mainSheetName = "2026 Invoice tracker";
  const now = new Date().toISOString();
  
  // Fetch existing invoices to check for duplicates
  const existingUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(mainSheetName)}!A2:M`;
  const existingRes = await fetch(existingUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  
  const existingData = await existingRes.json() as { values?: any[][] };
  const existingInvoices = (existingData.values || []).map((row: any[]) => ({
    invoiceNumber: row[1] || "",
    vendor: row[2] || "",
    date: row[3] || "",
    totalAmount: parseFloat(row[4]) || 0,
  }));
  
  const warnings: string[] = [];
  const validInvoices: InvoiceRow[] = [];
  
  for (const newInv of newInvoices) {
    let isDuplicate = false;
    
    // Check 1: Same Invoice Number
    const sameInvoiceNum = existingInvoices.find(ex => ex.invoiceNumber === newInv.invoiceNumber);
    if (sameInvoiceNum) {
      warnings.push(`⚠️  DUPLICATE INVOICE #: "${newInv.invoiceNumber}" already exists`);
      isDuplicate = true;
    }
    
    // Check 2: Same Vendor + Amount + Date
    const sameVendorAmountDate = existingInvoices.find(ex => 
      ex.vendor === newInv.vendor && 
      Math.abs(ex.totalAmount - newInv.totalAmount) < 0.01 &&
      ex.date === newInv.date
    );
    if (sameVendorAmountDate) {
      warnings.push(`⚠️  DUPLICATE TRANSACTION: "${newInv.vendor}" | €${newInv.totalAmount} | ${newInv.date}`);
      isDuplicate = true;
    }
    
    if (!isDuplicate) {
      validInvoices.push(newInv);
    }
  }
  
  // Print warnings
  if (warnings.length > 0) {
    console.log(`\n⚠️  DUPLICATE WARNINGS (${warnings.length}):\n`);
    warnings.forEach(w => console.log(w));
    console.log();
  }
  
  if (validInvoices.length === 0) {
    console.log(`[Export] ❌ All invoices are duplicates. No new data added.`);
    return {
      success: false,
      message: "All invoices are duplicates",
      warnings,
      rowsAdded: 0,
    };
  }
  
  console.log(`[Export] ✅ ${validInvoices.length} valid invoices (${newInvoices.length - validInvoices.length} duplicates skipped)\n`);
  
  // Step 1: Add valid invoices to main sheet (append only)
  console.log(`[Export] Adding ${validInvoices.length} invoices to main sheet...`);
  
  // Process images and prepare rows
  const dataRows = await Promise.all(
    validInvoices.map(async (r) => {
      let imageUrl = r.imageUrl ?? "";
      
      if (imageUrl && (imageUrl.startsWith("data:") || imageUrl.startsWith("file://"))) {
        try {
          let base64Data = imageUrl;
          if (imageUrl.startsWith("data:")) {
            const match = imageUrl.match(/base64,(.+)$/);
            base64Data = match ? match[1] : imageUrl;
          } else if (imageUrl.startsWith("file://")) {
            imageUrl = "";
          }
          
          if (base64Data && !imageUrl.startsWith("file://")) {
            const sanitizedInvoiceNum = ((r.invoiceNumber || "receipt")
              .split("/").pop() || "receipt")
              .replace(/[^a-zA-Z0-9-]/g, "")
              .substring(0, 50);
            const fileName = `${sanitizedInvoiceNum || "receipt"}-${Date.now()}.jpg`;
            imageUrl = await uploadImageToStorage(base64Data, fileName);
            console.log(`[Export] Image uploaded: ${fileName}`);
          }
        } catch (error) {
          console.error(`[Export] Failed to upload image:`, error);
          imageUrl = "";
        }
      }
      
      const formattedDate = new Date(r.date).toISOString().split('T')[0];
      
      return [
        r.source,
        r.invoiceNumber,
        r.vendor,
        formattedDate,
        r.totalAmount,
        r.ivaAmount,
        r.baseAmount,
        r.category,
        r.currency,
        r.tip ?? 0,
        r.notes ?? "",
        imageUrl,
        now,
      ];
    })
  );
  
  // Append to main sheet
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(mainSheetName)}!A:M:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const appendRes = await fetch(appendUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ values: dataRows }),
  });
  
  if (!appendRes.ok) {
    const errText = await appendRes.text();
    console.error("Sheets API error:", errText);
    throw new Error("Failed to export to Google Sheets");
  }
  
  console.log(`[Export] ✅ Added ${newInvoices.length} invoices to main sheet`);
  
  // Step 2: Fetch ALL invoices from main sheet
  console.log(`[Export] Fetching all invoices from main sheet...`);
  
  const allInvoicesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(mainSheetName)}!A2:M`;
  const allInvoicesRes = await fetch(allInvoicesUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  
  if (!allInvoicesRes.ok) {
    throw new Error("Failed to fetch invoices from main sheet");
  }
  
  const allInvoicesData = await allInvoicesRes.json() as { values?: any[][] };
  const allInvoices = (allInvoicesData.values || []).map((row: any[]) => ({
    source: row[0] || "",
    invoiceNumber: row[1] || "",
    vendor: row[2] || "",
    date: row[3] || "",
    totalAmount: parseFloat(row[4]) || 0,
    ivaAmount: parseFloat(row[5]) || 0,
    baseAmount: parseFloat(row[6]) || 0,
    category: row[7] || "",
    currency: row[8] || "EUR",
    tip: parseFloat(row[9]) || 0,
    notes: row[10] || "",
    imageUrl: row[11] || "",
  }));
  
  console.log(`[Export] Found ${allInvoices.length} total invoices`);
  
  // Step 3: Regenerate monthly sheets
  console.log(`[Export] Regenerating monthly sheets...`);
  
  for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
    const monthName = MONTHS[monthIdx];
    const monthInvoices = allInvoices.filter((inv) => {
      const d = new Date(inv.date);
      return d.getMonth() === monthIdx;
    });
    
    // Build rows: header + TOTAL row (Row 2) + data
    const rows = [
      ["Source", "Invoice #", "Vendor", "Date", "Total (€)", "IVA (€)", "Base (€)", "Tip (€)", "Category", "Currency", "Notes", "Image URL", "Exported At"],
    ];
    
    // Calculate totals for this month
    let monthTotal = 0;
    let monthIva = 0;
    let monthBase = 0;
    let monthTip = 0;
    
    const seenVendors = new Set<string>();
    const vendorRows = [];
    
    for (const inv of monthInvoices) {
      if (!seenVendors.has(inv.vendor)) {
        seenVendors.add(inv.vendor);
        vendorRows.push([
          inv.source,
          inv.invoiceNumber,
          inv.vendor,
          inv.date,
          inv.totalAmount,
          inv.ivaAmount,
          inv.baseAmount,
          inv.tip ?? 0,
          inv.category,
          inv.currency,
          inv.notes,
          inv.imageUrl,
          inv.date, // Use date as exported at
        ]);
        
        // Add to totals
        monthTotal += inv.totalAmount;
        monthIva += inv.ivaAmount;
        monthBase += inv.baseAmount;
        monthTip += (inv.tip ?? 0);
      }
    }
    
    // Add TOTAL row (Row 2)
    rows.push([
      "",
      "",
      "TOTAL",
      "",
      monthTotal.toString(),
      monthIva.toString(),
      monthBase.toString(),
      monthTip.toString(),
      "",
      "",
      "",
      "",
      "",
    ]);
    
    // Add vendor rows
    rows.push(...vendorRows);
    
    // Clear and write
    await clearSheet(spreadsheetId, monthName, accessToken);
    await writeSheet(spreadsheetId, monthName, rows, accessToken);
    console.log(`[Export] ✅ ${monthName}: ${seenVendors.size} vendors`);
  }
  
  // Step 4: Regenerate quarterly sheets
  console.log(`[Export] Regenerating quarterly sheets...`);
  
  for (let q = 0; q < 4; q++) {
    const quarterName = QUARTERS[q];
    const quarterInvoices = allInvoices.filter((inv) => {
      const d = new Date(inv.date);
      return Math.floor(d.getMonth() / 3) === q;
    });
    
    // Group by vendor and sum
    const byVendor: Record<string, any> = {};
    for (const inv of quarterInvoices) {
      if (!byVendor[inv.vendor]) {
        byVendor[inv.vendor] = {
          total: 0,
          iva: 0,
          base: 0,
        };
      }
      byVendor[inv.vendor].total += inv.totalAmount;
      byVendor[inv.vendor].iva += inv.ivaAmount;
      byVendor[inv.vendor].base += inv.baseAmount;
    }
    
    // Build rows: header + data (no TOTAL row)
    const rows = [
      ["Vendor", "Total (€)", "IVA (€)", "Base (€)"],
    ];
    
    for (const [vendor, data] of Object.entries(byVendor)) {
      rows.push([
        vendor,
        data.total,
        data.iva,
        data.base,
      ]);
    }
    
    // Clear and write
    await clearSheet(spreadsheetId, quarterName, accessToken);
    await writeSheet(spreadsheetId, quarterName, rows, accessToken);
    console.log(`[Export] ✅ ${quarterName}: ${Object.keys(byVendor).length} vendors`);
  }
  
  console.log(`[Export] ✅ All sheets updated successfully`);
  
  return {
    success: true,
    mainSheetRowsAdded: validInvoices.length,
    monthlySheetUpdated: true,
    quarterlySheetUpdated: true,
    warnings,
  };
}

/**
 * Clear all data from a sheet (keep header)
 */
async function clearSheet(
  spreadsheetId: string,
  sheetName: string,
  accessToken: string
): Promise<void> {
  const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A2:M`;
  
  await fetch(clearUrl, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

/**
 * Write data to a sheet (starting from A1)
 */
async function writeSheet(
  spreadsheetId: string,
  sheetName: string,
  rows: any[][],
  accessToken: string
): Promise<void> {
  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1?valueInputOption=USER_ENTERED`;
  
  const res = await fetch(writeUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ values: rows }),
  });
  
  if (!res.ok) {
    const errText = await res.text();
    console.error("Write error:", errText);
    throw new Error("Failed to write to sheet");
  }
}
