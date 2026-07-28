from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.templating import Jinja2Templates

from app.exporter import generate_excel_bytes
from app.parser import parse_asset_tag


BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Inventory Scanner App", version="1.0.0")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

session_lock = Lock()
session_items: list[dict[str, str]] = []


class ScanRequest(BaseModel):
    qr_code: str = Field(min_length=1)


@app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html")


@app.post("/api/scan")
async def scan_item(payload: ScanRequest) -> dict[str, object]:
    try:
        parsed = parse_asset_tag(payload.qr_code)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    record = {
        "Item Name": parsed.raw_qr_code,
        "Company": parsed.company,
        "Location": parsed.location,
        "Device Type": parsed.device_type,
        "Date Acquired": parsed.date_acquired,
        "Sequence Number": parsed.sequence_number,
        "Scan Timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    with session_lock:
        session_items.append(record)
        session_count = len(session_items)

    return {"message": "Scan recorded.", "record": record, "session_count": session_count}


@app.get("/api/session")
async def get_session() -> dict[str, object]:
    with session_lock:
        return {"items": session_items.copy(), "count": len(session_items)}


@app.post("/api/clear-session")
async def clear_session() -> dict[str, str]:
    with session_lock:
        session_items.clear()
    return {"message": "Session cleared."}


@app.get("/api/export-excel")
async def export_excel() -> StreamingResponse:
    with session_lock:
        records = session_items.copy()

    excel_bytes = generate_excel_bytes(records)
    headers = {
        "Content-Disposition": 'attachment; filename="inventory_scans_monday.xlsx"'
    }
    return StreamingResponse(
        iter([excel_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )
