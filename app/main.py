from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
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
session_items_by_id: dict[str, list[dict[str, str]]] = {}

connections_lock = asyncio.Lock()
active_connections: dict[str, list[WebSocket]] = {}


class ScanRequest(BaseModel):
    qr_code: str = Field(min_length=1)


class RemoveScanRequest(BaseModel):
    qr_code: str = Field(min_length=1)


def get_or_create_session_records(session_id: str) -> list[dict[str, str]]:
    if session_id not in session_items_by_id:
        session_items_by_id[session_id] = []
    return session_items_by_id[session_id]


async def register_connection(session_id: str, websocket: WebSocket) -> None:
    await websocket.accept()
    async with connections_lock:
        if session_id not in active_connections:
            active_connections[session_id] = []
        active_connections[session_id].append(websocket)


async def unregister_connection(session_id: str, websocket: WebSocket) -> None:
    async with connections_lock:
        connections = active_connections.get(session_id, [])
        if websocket in connections:
            connections.remove(websocket)
        if not connections and session_id in active_connections:
            del active_connections[session_id]


async def broadcast_to_session(session_id: str, payload: dict[str, Any]) -> None:
    async with connections_lock:
        targets = list(active_connections.get(session_id, []))

    disconnected: list[WebSocket] = []
    for connection in targets:
        try:
            await connection.send_json(payload)
        except Exception:
            disconnected.append(connection)

    for connection in disconnected:
        await unregister_connection(session_id, connection)


async def publish_presence(session_id: str) -> None:
    async with connections_lock:
        connection_count = len(active_connections.get(session_id, []))

    await broadcast_to_session(
        session_id,
        {
            "type": "presence",
            "session_id": session_id,
            "connection_count": connection_count,
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    )


@app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html")


@app.get("/scanner", response_class=HTMLResponse)
async def scanner_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "scanner.html")


@app.post("/api/scan")
async def scan_item(payload: ScanRequest, session_id: str = Query(default="default")) -> dict[str, object]:
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
        session_items = get_or_create_session_records(session_id)
        session_items.append(record)
        session_count = len(session_items)

    return {
        "message": "Scan recorded.",
        "record": record,
        "session_id": session_id,
        "session_count": session_count,
    }


@app.get("/api/session")
async def get_session(session_id: str = Query(default="default")) -> dict[str, object]:
    with session_lock:
        session_items = get_or_create_session_records(session_id)
        return {"session_id": session_id, "items": session_items.copy(), "count": len(session_items)}


@app.post("/api/clear-session")
async def clear_session(session_id: str = Query(default="default")) -> dict[str, str]:
    with session_lock:
        session_items = get_or_create_session_records(session_id)
        session_items.clear()
    return {"message": "Session cleared.", "session_id": session_id}


@app.post("/api/remove-scan")
async def remove_scan(payload: RemoveScanRequest, session_id: str = Query(default="default")) -> dict[str, object]:
    normalized_qr = payload.qr_code.strip().upper()

    with session_lock:
        session_items = get_or_create_session_records(session_id)
        removed_record = None
        for index, record in enumerate(session_items):
            if record["Item Name"] == normalized_qr:
                removed_record = session_items.pop(index)
                break

        if removed_record is None:
            raise HTTPException(status_code=404, detail="Scanned tag not found in the current session.")

        return {
            "message": "Scan removed.",
            "removed": True,
            "record": removed_record,
            "session_id": session_id,
            "session_count": len(session_items),
        }


@app.get("/api/export-excel")
async def export_excel(session_id: str = Query(default="default")) -> StreamingResponse:
    with session_lock:
        records = get_or_create_session_records(session_id).copy()

    excel_bytes = generate_excel_bytes(records)
    headers = {
        "Content-Disposition": f'attachment; filename="inventory_scans_{session_id}_monday.xlsx"'
    }
    return StreamingResponse(
        iter([excel_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.websocket("/ws/{session_id}")
async def ws_session_bridge(websocket: WebSocket, session_id: str) -> None:
    await register_connection(session_id, websocket)
    await publish_presence(session_id)
    try:
        await websocket.send_json({
            "type": "connection_ack",
            "session_id": session_id,
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        while True:
            payload = await websocket.receive_json()
            qr_value = str(payload.get("qr_code", "")).strip().upper()
            outgoing = {
                "type": payload.get("type", "scan"),
                "session_id": session_id,
                "qr_code": qr_value,
                "timestamp": payload.get("timestamp")
                or datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            await broadcast_to_session(session_id, outgoing)
    except WebSocketDisconnect:
        pass
    finally:
        await unregister_connection(session_id, websocket)
        await publish_presence(session_id)
