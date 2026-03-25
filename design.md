# Invoice Tracker — Design Plan

## App Concept
A professional iOS invoice management app for a Spanish-based company. Users can capture paper receipts via camera or sync email invoices from Gmail, then automatically export all data to Google Sheets.

---

## Color Palette

| Token | Light | Dark | Purpose |
|-------|-------|------|---------|
| `primary` | `#1A56DB` | `#3B82F6` | Brand blue — buttons, active states |
| `background` | `#F8FAFC` | `#0F172A` | Screen background |
| `surface` | `#FFFFFF` | `#1E293B` | Cards, modals |
| `foreground` | `#0F172A` | `#F1F5F9` | Primary text |
| `muted` | `#64748B` | `#94A3B8` | Secondary text |
| `border` | `#E2E8F0` | `#334155` | Dividers |
| `success` | `#10B981` | `#34D399` | Synced / exported |
| `warning` | `#F59E0B` | `#FBBF24` | Pending review |
| `error` | `#EF4444` | `#F87171` | Failed / error |
| `camera` | `#7C3AED` | `#A78BFA` | Camera source badge |
| `email` | `#0891B2` | `#22D3EE` | Email source badge |

---

## Screen List

### 1. Home / Dashboard (`/`)
**Primary content:** Summary stats (total invoices, total amount, IVA total, pending exports), recent activity feed
**Functionality:** Quick-action buttons (Scan Receipt, Sync Gmail), pull-to-refresh

### 2. Receipts List (`/receipts`)
**Primary content:** FlatList of all invoices (both camera + email), filterable by source type
**Functionality:** Filter by source (Camera / Email), search by vendor, tap to view detail

### 3. Camera Scan (`/scan`)
**Primary content:** Full-screen camera viewfinder with capture button
**Functionality:** Take photo, preview, confirm → AI OCR extraction → review extracted data → export to Sheets

### 4. Gmail Sync (`/gmail`)
**Primary content:** Gmail connection status, list of fetched email invoices
**Functionality:** Connect Gmail via OAuth, fetch invoices, review parsed data, export to Sheets

### 5. Invoice Detail (`/receipts/[id]`)
**Primary content:** Full invoice data (source, vendor, date, invoice #, amount, IVA, category)
**Functionality:** Edit fields, re-export to Sheets, delete

### 6. Settings (`/settings`)
**Primary content:** Google Sheets connection, Gmail connection, app preferences
**Functionality:** Connect/disconnect Google Sheets, connect/disconnect Gmail, manage spreadsheet ID

---

## Key User Flows

### Flow A: Camera Receipt
1. Home → tap "Scan Receipt"
2. Camera screen opens → user frames receipt → taps capture
3. Photo preview shown → confirm or retake
4. Loading: AI OCR processes image
5. Review screen: extracted fields (vendor, date, invoice #, amount, IVA, category) shown for editing
6. Tap "Export to Sheets" → success confirmation
7. Returns to Home with updated stats

### Flow B: Gmail Invoice
1. Home → tap "Sync Gmail" (or Gmail tab)
2. If not connected: OAuth flow → Gmail authorization
3. Fetching emails with invoice keywords
4. List of parsed invoices shown
5. User reviews each → taps "Export All" or individual export
6. Success confirmation with sheet row reference

---

## Tab Bar (4 tabs)
1. **Home** — house.fill
2. **Receipts** — doc.text.fill
3. **Scan** — camera.fill (center, prominent)
4. **Gmail** — envelope.fill
5. **Settings** — gearshape.fill

---

## Layout Principles
- All screens use `ScreenContainer` with safe area handling
- Cards use 12px border radius, subtle shadow on light mode
- Source badges: purple pill for "Camera", cyan pill for "Email"
- Amount display: always show total and IVA separately
- Loading states: skeleton cards, not spinners
- Empty states: illustrated with action CTA
