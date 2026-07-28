# Inventory Management Mobile Scanner

FastAPI app for scanning asset QR codes, parsing the encoded asset tag, and exporting a Monday.com-ready Excel workbook.

## Features

- Mobile-friendly QR scanner using the camera
- Regex validation and parsing for tags like `CRAML06210001` and `CRAAMPC02240015`
- In-memory scan session for the current browser session
- Excel export with monday.com import-friendly column names

## Local Setup

1. Create and activate a virtual environment:

   ```powershell
   python -m venv venv
   .\venv\Scripts\Activate.ps1
   ```

2. Install dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

3. Start the server:

   ```powershell
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```

4. Open the app:

   - On the computer: `http://127.0.0.1:8000`
   - On your phone: `http://<your-computer-local-ip>:8000`

## QR Format

Expected tag structure:

- `CRA` = company prefix
- `M`, `Q`, or `A` = location code
- `L`, `C`, or `MPC` = device type code
- `MMYY` = date acquired
- `0000` = sequence number

## Export Columns

The generated workbook uses these headers:

- `Item Name`
- `Company`
- `Location`
- `Device Type`
- `Date Acquired`
- `Sequence Number`
- `Scan Timestamp`
