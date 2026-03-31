import { google } from "googleapis";
import * as fs from "fs";

/**
 * Update all monthly and quarterly sheets to use SUM formulas in TOTAL rows
 */
async function updateSheetsFormulas() {
  // Get credentials from environment
  const spreadsheetId = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
  
  // Use service account or OAuth token
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // List of all sheets to update
  const sheetNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
    "Q1", "Q2", "Q3", "Q4"
  ];

  console.log("🔄 Updating all sheets with SUM formulas...");

  for (const sheetName of sheetNames) {
    try {
      // Update TOTAL row (Row 2) with SUM formulas
      const updateRequest = {
        spreadsheetId,
        range: `'${sheetName}'!E2:H2`,
        valueInputOption: "USER_ENTERED",
        data: {
          values: [
            [
              "=SUM(E3:E)",  // E2: Total (€)
              "=SUM(F3:F)",  // F2: IVA (€)
              "=SUM(G3:G)",  // G2: Base (€)
              "=SUM(H3:H)",  // H2: Tip (€)
            ]
          ]
        }
      };

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          data: [updateRequest],
          valueInputOption: "USER_ENTERED"
        }
      });

      console.log(`✅ Updated ${sheetName} sheet`);
    } catch (error) {
      console.error(`❌ Failed to update ${sheetName}:`, error);
    }
  }

  console.log("✅ All sheets updated successfully!");
}

updateSheetsFormulas().catch(console.error);
