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
