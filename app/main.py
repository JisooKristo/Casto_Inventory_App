from __future__ import annotations

import asyncio
import socket
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
from app.parser import device_requires_serial_number, parse_asset_tag


BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Inventory Scanner App", version="1.0.0")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

session_lock = Lock()
session_items_by_id: dict[str, list[dict[str, str]]] = {}
pending_scan_by_session_id: dict[str, dict[str, str]] = {}

connections_lock = asyncio.Lock()
active_connections: dict[str, list[WebSocket]] = {}


class ScanRequest(BaseModel):
    qr_code: str = Field(min_length=1)


class RemoveScanRequest(BaseModel):
    qr_code: str = Field(min_length=1)


class CompleteScanRequest(BaseModel):
    serial_number: str = Field(default="N/A")
    skip_serial_number: bool = False


def get_or_create_session_records(session_id: str) -> list[dict[str, str]]:
    if session_id not in session_items_by_id:
        session_items_by_id[session_id] = []
    return session_items_by_id[session_id]


def build_session_record(parsed: Any, serial_number: str) -> dict[str, str]:
    return {
        "Item Name": getattr(parsed, "raw_qr_code"),
        "Company": getattr(parsed, "company"),
        "Location": getattr(parsed, "location"),
        "Device Type": getattr(parsed, "device_type"),
        "Serial Number": serial_number,
        "serial_number": serial_number,
        "Date Acquired": getattr(parsed, "date_acquired"),
        "Sequence Number": getattr(parsed, "sequence_number"),
        "Scan Timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def normalize_serial_number(serial_number: str | None) -> str:
    value = str(serial_number or "").strip().upper()
    return value or "N/A"


def get_pairing_origin(request: Request) -> str:
    host = request.url.hostname or "127.0.0.1"
    if host in {"localhost", "127.0.0.1", "0.0.0.0"}:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect(("8.8.8.8", 80))
                host = probe.getsockname()[0]
        except OSError:
            host = "127.0.0.1"

    port = request.url.port
    scheme = request.url.scheme
    if port in (80, 443, None):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


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


async def publish_scan_completed(session_id: str, record: dict[str, str], source: str = "server") -> None:
    await broadcast_to_session(
        session_id,
        {
            "type": "scan_completed",
            "session_id": session_id,
            "source": source,
            "record": record,
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    )


@app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html", {"request": request, "pairing_origin": get_pairing_origin(request)})


@app.get("/scanner", response_class=HTMLResponse)
async def scanner_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "scanner.html")


@app.get("/api/pairing-origin")
async def pairing_origin(request: Request) -> dict[str, str]:
    return {"origin": get_pairing_origin(request)}


@app.post("/api/scan")
async def scan_item(payload: ScanRequest, session_id: str = Query(default="default")) -> dict[str, object]:
    try:
        parsed = parse_asset_tag(payload.qr_code)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if device_requires_serial_number(parsed.device_type):
        pending_scan = {
            "Item Name": parsed.raw_qr_code,
            "Company": parsed.company,
            "Location": parsed.location,
            "Device Type": parsed.device_type,
            "Date Acquired": parsed.date_acquired,
            "Sequence Number": parsed.sequence_number,
        }

        with session_lock:
            pending_scan_by_session_id[session_id] = pending_scan

        return {
            "message": "Asset tag captured. Serial number required.",
            "scan_status": "awaiting_serial_number",
            "requires_serial_number": True,
            "asset": pending_scan,
            "session_id": session_id,
        }

    record = build_session_record(parsed, "N/A")

    with session_lock:
        session_items = get_or_create_session_records(session_id)
        session_items.append(record)
        session_count = len(session_items)

    await publish_scan_completed(session_id, record)

    return {
        "message": "Scan recorded.",
        "scan_status": "complete",
        "requires_serial_number": False,
        "record": record,
        "session_id": session_id,
        "session_count": session_count,
    }


@app.post("/api/complete-scan")
async def complete_scan(payload: CompleteScanRequest, session_id: str = Query(default="default")) -> dict[str, object]:
    with session_lock:
        pending_scan = pending_scan_by_session_id.get(session_id)
        if not pending_scan:
            raise HTTPException(status_code=404, detail="No pending asset tag scan exists for this session.")

        serial_number = "N/A" if payload.skip_serial_number else normalize_serial_number(payload.serial_number)
        record = {
            **pending_scan,
            "Serial Number": serial_number,
            "serial_number": serial_number,
            "Scan Timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }

        session_items = get_or_create_session_records(session_id)
        session_items.append(record)
        session_count = len(session_items)
        del pending_scan_by_session_id[session_id]

    await publish_scan_completed(session_id, record)

    return {
        "message": "Scan completed.",
        "scan_status": "complete",
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
        pending_scan_by_session_id.pop(session_id, None)

    await broadcast_to_session(
        session_id,
        {
            "type": "session_cleared",
            "session_id": session_id,
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    )

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

        remaining_count = len(session_items)

    await broadcast_to_session(
        session_id,
        {
            "type": "scan_removed",
            "session_id": session_id,
            "record": removed_record,
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    )

    return {
        "message": "Scan removed.",
        "removed": True,
        "record": removed_record,
        "session_id": session_id,
        "session_count": remaining_count,
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
                "source": payload.get("source", "client"),
                "qr_code": qr_value,
                "record": payload.get("record"),
                "timestamp": payload.get("timestamp")
                or datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            await broadcast_to_session(session_id, outgoing)
    except WebSocketDisconnect:
        pass
    finally:
        await unregister_connection(session_id, websocket)
        await publish_presence(session_id)
