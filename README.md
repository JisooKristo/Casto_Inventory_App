# Inventory Management Mobile Scanner

This project is a lightweight inventory scanning web application built with FastAPI, Jinja2 templates, WebSockets, and a mobile-friendly barcode scanner client. It is designed for teams that need to capture asset-tag scans, collect serial numbers for certain devices, and export the results into an Excel workbook that can be imported into Monday.com or similar tools.

## 1. What the app does

The application has two main parts:

- A desktop-style dashboard that acts as the control panel for an inventory session.
- A mobile scanner page that opens on a phone and uses the device camera to scan asset QR codes and serial barcodes.

The workflow is:

1. A laptop opens the dashboard and creates or reuses a session ID.
2. The dashboard shows a QR code that can be scanned by a phone.
3. The phone opens the scanner page and joins the same session.
4. The phone scans an asset QR tag.
5. If the scanned device requires a serial number, the phone prompts for a second scan.
6. The scan is sent to the backend, stored in memory, and immediately appears on the dashboard.
7. The user can export the collected data as an Excel file.

## 2. Project structure

- app/main.py: FastAPI application, API routes, WebSocket bridge, session state, and scan processing.
- app/parser.py: QR/barcode parsing logic and validation rules.
- app/exporter.py: Excel export generation using pandas and openpyxl.
- app/templates/index.html: Laptop dashboard UI.
- app/templates/scanner.html: Mobile scanner UI.
- app/static/app.js: Dashboard client-side logic.
- app/static/scanner.js: Mobile scanner client-side logic.
- app/static/style.css: Shared styling.

## 3. Core features

- Mobile-friendly camera-based scanning
- QR code parsing for asset tags such as CRA asset identifiers
- Serial number capture for devices that require it
- Real-time updates through WebSockets
- Session-based tracking so multiple devices can work in the same inventory batch
- Excel export with Monday.com-friendly column names
- Manual entry fallback for scanned tags or barcodes that may be difficult to read

## 4. How the web app works

### 4.1 Dashboard page

The dashboard is served at the root route, /, and is built from the template in app/templates/index.html.

When the page loads:

- A session ID is generated and stored in browser local storage.
- A pairing QR code is created pointing to the mobile scanner URL.
- A WebSocket connection is opened to the backend.
- The current session data is loaded from the server.

The dashboard shows:

- A pairing QR code for the phone
- The active session ID
- A live count of scanned items
- The latest scan preview
- Buttons to clear the session and export the data to Excel

### 4.2 WebSocket connection

The dashboard uses a WebSocket endpoint at /ws/{session_id}. This connection is used for real-time presence and scan updates.

The server broadcasts updates to all connected clients that belong to the same session. This allows the laptop dashboard to reflect scans immediately as they arrive from the phone scanner client.

### 4.3 Session state

The application stores scan records in memory in the server process. Records are grouped by session ID and are available while the server is running.

Important note:

- Session data is not persisted to a database.
- Restarting the server clears the in-memory sessions.
- The app is intended for short-lived scanning workflows rather than long-term inventory storage.

## 5. How the scanner client works

The scanner client is served at /scanner and is intended to be opened on a phone.

### 5.1 Scanner flow

When the mobile page loads:

- It reads the session ID from the URL query string.
- It opens a WebSocket connection to the same backend session.
- It starts the camera and enters the asset scan step.

### 5.2 Step 1: Scan the asset QR tag

The phone camera is initialized in QR mode. The user scans the asset tag.

The frontend sends the value to the server endpoint /api/scan.

The server validates the tag format and parses it into structured information such as:

- Company
- Location
- Device type
- Date acquired
- Sequence number

### 5.3 Step 2: Serial number capture

Some device types require a serial number. The parser marks these as requiring additional input.

When that happens:

- The scanner UI switches to the second step.
- The phone camera switches to support 1D barcode formats.
- The user scans the serial number barcode.
- The server completes the scan and stores the full record.

If the item does not have a serial number, the user can press the Skip Serial Number button.

### 5.4 Manual entry fallback

If the camera scan is not successful, the scanner page includes a manual input field. The user can type a barcode or tag value and send it manually.

## 6. QR and barcode parsing rules

The parser logic in app/parser.py accepts a few input formats.

### 6.1 Asset tag format

Asset tags are expected to follow a pattern similar to:

- CRA + location code + device code + date/sequence

Example structure:

- CRA = company prefix
- M, Q, or A = location code
- L, C, MPC, K, M, H, or D = device type code
- MMYY + 4-digit sequence, or a 4/5-digit sequence without a date

Examples:

- CRA M L 06210001
- CRA A MPC 02240015

The parser translates the code into human-readable values such as:

- Makati, Quezon City, or Alabang
- Laptop, Mini PC, System Unit/Computer, Keyboard, Mouse, Headset, or Monitor

### 6.2 Serial number format

The parser also accepts serial numbers encoded in barcodes if they match a simple allowed pattern. This is used only for serial-number capture after the asset tag is scanned.

## 7. Backend API reference

The API is defined in app/main.py.

### 7.1 GET /

Renders the laptop dashboard page.

### 7.2 GET /scanner

Renders the mobile scanner page.

### 7.3 POST /api/scan

Accepts a QR code string and stores a scan record if the tag is valid.

Request body:

```json
{
  "qr_code": "CRAML06210001"
}
```

Behavior:

- Validates the asset tag
- Returns a pending state if the device requires a serial number
- Stores the pending scan in memory for the current session

### 7.4 POST /api/complete-scan

Completes the pending scan after the serial number has been collected or skipped.

Request body:

```json
{
  "serial_number": "SN123456",
  "skip_serial_number": false
}
```

### 7.5 GET /api/session

Returns the current scan records for the provided session ID.

### 7.6 POST /api/clear-session

Clears all records for the active session.

### 7.7 POST /api/remove-scan

Removes a scan record from the current session by matching the item name.

### 7.8 GET /api/export-excel

Exports the current session's records as an Excel workbook.

### 7.9 WebSocket /ws/{session_id}

Used for real-time communication between the dashboard and the mobile scanner.

## 8. Data export

The export logic in app/exporter.py converts the session data into an Excel workbook.

The exported workbook contains the following columns:

- Item Name
- Company
- Location
- Device Type
- Serial Number
- Date Acquired
- Sequence Number
- Scan Timestamp

The workbook is styled with a header row and auto-sized columns to make it easier to review in Excel.

## 9. Local setup

### 9.1 Create and activate a virtual environment

On Windows PowerShell:

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
```

### 9.2 Install dependencies

```powershell
pip install -r requirements.txt
```

### 9.3 Run the server

```powershell
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 9.4 Open the app

- Laptop dashboard: http://127.0.0.1:8000/
- Mobile scanner: http://127.0.0.1:8000/scanner?session=YOUR_SESSION_ID

If you are opening it from a phone on the same network, use your computer's local IP address instead of 127.0.0.1.

## 10. Typical usage example

1. Open the dashboard on a laptop.
2. Scan the pairing QR code from a phone.
3. On the phone, scan an asset tag.
4. If prompted, scan the serial number.
5. Watch the dashboard update instantly.
6. Click Download Excel for Monday.com to save the results.

## 11. Limitations and notes

- All data is stored in memory and will be lost when the server restarts.
- The app depends on the browser camera and WebSocket support.
- The scanner client is best used on a modern mobile browser.
- The QR parsing rules are specific to the expected asset tag format used by this inventory workflow.

## 12. Troubleshooting

- No camera detected: ensure the browser has camera permissions and that the device has a working camera.
- Session not syncing: make sure the phone and laptop are using the same session URL and that the WebSocket connection is available.
- Invalid scan format: confirm the asset tag matches the expected CRA format.
- Export fails: ensure the session contains at least one record before exporting.

