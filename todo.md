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
