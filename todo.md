# Invoice Tracker — TODO

## Branding & Setup
- [x] Generate app logo (invoice/receipt themed, blue brand)
- [x] Update theme colors (primary blue, camera purple, email cyan)
- [x] Update app.config.ts with app name and logo URL
- [x] Add all required icon mappings to icon-symbol.tsx

## Navigation & Core UI
- [x] Set up 5-tab navigation (Home, Receipts, Scan, Gmail, Settings)
- [x] Home/Dashboard screen with stats and quick actions
- [x] Receipts list screen with source filter (Camera / Email)
- [x] Invoice detail screen

## Camera & OCR
- [x] Camera scan screen with full-screen viewfinder
- [x] Photo capture and preview flow
- [x] Server-side AI OCR endpoint (invokeLLM with image)
- [x] OCR review/edit screen before export
- [x] expo-camera and expo-image-picker integration

## Gmail Integration
- [x] Gmail OAuth connection flow (Google OAuth)
- [x] Gmail API fetch invoices endpoint (server-side)
- [x] Email invoice parsing with AI (vendor, amount, IVA, category)
- [x] Gmail invoices list screen
- [x] Individual email invoice review screen

## Google Sheets Integration
- [x] Google Sheets API connection (OAuth)
- [x] Server-side Sheets write endpoint
- [x] Export camera receipt to Sheets
- [x] Export email invoice to Sheets
- [x] Settings screen for Sheets configuration (spreadsheet ID)

## Settings
- [x] Settings screen
- [x] Google account connection status
- [x] Spreadsheet ID configuration
- [x] App preferences

## Polish
- [x] Empty states for all lists
- [x] Error handling and user feedback
- [x] Loading states (skeleton cards)
- [x] Haptic feedback on key actions

## Statistics & Analytics
- [x] Monthly statistics screen with charts
- [x] Category-wise statistics screen
- [x] Monthly expense trend chart (Line Chart)
- [x] Category-wise expense ratio chart (Pie Chart)
- [x] Statistics data calculation (total, IVA, average)
- [x] Month selection filter
- [x] Statistics tab in navigation

## OAuth Simplification (Current)
- [x] Remove complex OAuth flow from settings screen
- [x] Simplify Gmail integration to use backend API directly
- [x] Simplify Google Sheets export to use backend API directly
- [x] Test end-to-end flow without OAuth complications

## Gmail OAuth Removal & Direct Export (Latest)
- [x] Remove Gmail OAuth dependency from export flow
- [x] Replace OAuth credentials with Google API Key in Settings
- [x] Update backend to use API Key instead of OAuth tokens
- [x] Enable direct Google Sheets export without Gmail connection
- [x] Add manual invoice entry feature in Receipts tab
- [x] Handle missing invoice numbers (auto-generate if empty)
- [x] Test complete flow: Camera scan → AI extraction → Google Sheets export
- [x] Test manual invoice entry → Google Sheets export
- [x] Verify Settings page shows new API Key field

## Google Sheets Service Account Fix (Current Session)
- [x] Identified JWT token generation issue
- [x] Fixed Google Sheets API URL format (removed extra colon)
- [x] Verified Service Account authentication working
- [x] Tested end-to-end export: Camera receipt → Google Sheets
- [x] Confirmed data successfully written to Google Sheet
- [x] IKEA receipt data (€324, €56.23 IVA, €267.77 Base) exported successfully

## Feature Improvements (Current Session)
- [x] Fix photo library image parsing error (FileSystem-based Base64)
- [x] Add tip field to receipt data model
- [x] Add tip field to Scan screen UI
- [x] Add image URL field to export data
- [x] Create Google Sheets automation module
- [x] Implement monthly sheet creation (January-December)
- [x] Implement quarterly summary sheets (Q1-Q4)
- [x] Create Meat tracking sheets (La portenia, es cuco)
- [x] Create Dashboard sheet
- [x] Integrate automation with export flow
- [x] Enable background automation

## Testing & Deployment
- [ ] Test photo library image upload
- [ ] Test tip field in scan screen
- [ ] Test monthly sheet creation
- [ ] Test quarterly sheet creation
- [ ] Test Meat tracking sheets
- [ ] Test Dashboard sheet generation
- [ ] Verify all data organization
- [ ] Create final checkpoint

## Executive Summary for Investor Reporting (NEW)
- [x] Design Executive Summary sheet structure with key metrics
- [x] Implement Executive Summary sheet creation in Google Sheets (both sheets-automation.ts and sheets-automation-enhanced.ts)
- [x] Add analysis period fields (Quarter, Year, Date Range)
- [x] Calculate and display core metrics (total spending, meat spending, vendor count, average)
- [x] Create TOP 3 vendor breakdown section with percentages
- [x] Add monthly trend analysis
- [x] Integrate Executive Summary into automation flow
- [ ] Test Executive Summary generation with real data
- [ ] Verify investor-ready formatting and presentation

## Batch Upload & Duplicate Detection (NEW)
- [x] Design batch upload flow with sequential review
- [x] Implement multi-image picker (allow selecting multiple photos)
- [x] Add batch OCR processing with progress indicator (1/5, 2/5, etc)
- [x] Create sequential review screen with Next/Previous buttons
- [x] Implement duplicate detection (by Invoice #, Vendor+Amount+Date)
- [x] Add duplicate warning dialog with options (Skip/Continue/Replace)
- [x] Add "Export All" button for batch export
- [ ] Test batch upload with multiple receipts
- [ ] Test duplicate detection and warning messages
- [ ] Verify all receipts export correctly

## Gmail Invoice Automation with Apps Script (NEW)
- [x] Create Google Apps Script for Gmail invoice extraction
- [x] Implement invoice keyword filtering (Spanish + English)
- [x] Integrate Gemini API for AI parsing
- [x] Add duplicate detection logic
- [x] Create automatic Google Sheets insertion
- [ ] Set up automatic triggers in Google Sheets
- [ ] Test Gmail automation with real emails
- [ ] Verify data accuracy and formatting
- [ ] Monitor and debug any issues

## Google Sheets Layout Fix (Current)
- [x] Fix monthly sheet layout (separate transactions from summary)
- [x] Combine individual transactions and monthly summary in one append
- [ ] Test fixed layout with real data
- [ ] Verify summary calculations are correct

## Image URL Generation Fix (Current Issue)
- [x] Fix image filename generation to be consistent
- [x] Ensure all images use same path structure: invoices/{timestamp}-{random}/{fileName}
- [x] Fix vendor name extraction for filename (some images have folder structure)
- [x] Create filename sanitization tests (11 tests, all passing)
- [x] Verify all 3 problematic images now display in Google Sheets
- [x] Test end-to-end image upload and display

## Meat Cut-Level Detail Tracking (NEW)
- [x] Add items field to exportToSheets input schema
- [x] Update InvoiceRecord interface to include items
- [x] Create createMeatDetailSheet function
- [x] Add Meat_Detail sheet to automation flow
- [ ] Test meat invoice upload with cut details
- [ ] Verify Meat_Detail sheet populates correctly
- [ ] Test monthly aggregation of meat cuts


## Google Sheets Structure Redesign (NEW - Major Refactor)
- [ ] Create Supplier master sheet with: Category, Name, Product, Proof, Note
- [ ] Add supplier management to app (add new supplier, edit category)
- [ ] Redesign monthly sheets layout:
  * Left side: Transaction details (Date, Supplier, Total, IVA, Base, Factura #, Note, Who, Photo)
  * Right side: Monthly statistics by supplier (Supplier, Total, IVA, Base, %)
- [ ] Implement automatic supplier statistics calculation with SUMIF
- [ ] Add region field to invoice data model (Ibiza, Madrid, Cape Town, UAE, etc.)
- [ ] Create regional tracking sheets (Ibiza, Madrid, Cape Town, UAE, Out of Spain)
- [ ] Implement quarterly summary sheets (Q1, Q2, Q3, Q4)
- [ ] Add "who" field to invoice (staff member name)
- [ ] Update scan screen UI to capture: Region, Who, Supplier Category
- [ ] Test complete automation with new structure
- [ ] Verify all sheets generate correctly with sample data
