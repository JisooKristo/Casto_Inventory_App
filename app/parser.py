from __future__ import annotations

import re
from dataclasses import dataclass


LOCATION_MAP = {
    "M": "Makati",
    "Q": "Quezon City",
    "A": "Alabang",
}

DEVICE_MAP = {
    "L": "Laptop",
    "C": "System Unit/Computer",
    "MPC": "Mini PC",
    "K": "Keyboard",
    "M": "Mouse",
    "H": "Headset",
    "D": "Display/Monitor",
}

SERIAL_REQUIRED_DEVICE_TYPES = {
    "Laptop",
    "Mini PC",
    "Display/Monitor",
    "Headset",
}

# Matches 3 formats:
# 1. Dated (4-digit sequence): CRA + Location + Device + MMYY (4 digits) + Sequence (4 digits)
# 2. Dateless (5-digit sequence): CRA + Location + Device + Sequence (5 digits)
# 3. Dateless (4-digit sequence): CRA + Location + Device + Sequence (4 digits)
QR_PATTERN = re.compile(
    r"^"
    r"(?P<company>CRA)"
    r"(?P<location_code>[MQA])"
    r"(?P<device_type_code>MPC|[LCKMHD])"
    r"(?:"
        r"(?P<date_acquired>(0[1-9]|1[0-2])\d{2})(?P<sequence_dated>\d{4})"
        r"|"
        r"(?P<sequence_5>\d{5})"
        r"|"
        r"(?P<sequence_4>\d{4})"
    r")"
    r"$"
)

SERIAL_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9\-_/.:]{2,63}$")


@dataclass(frozen=True)
class ParsedAssetTag:
    raw_qr_code: str
    company: str
    location_code: str
    location: str
    device_type_code: str
    device_type: str
    date_acquired: str
    sequence_number: str
    serial_number: str = "N/A"

    def to_dict(self) -> dict[str, str]:
        return {
            "raw_qr_code": self.raw_qr_code,
            "company": self.company,
            "location_code": self.location_code,
            "location": self.location,
            "device_type_code": self.device_type_code,
            "device_type": self.device_type,
            "date_acquired": self.date_acquired,
            "sequence_number": self.sequence_number,
            "serial_number": self.serial_number,
        }


def device_requires_serial_number(device_type: str) -> bool:
    return device_type in SERIAL_REQUIRED_DEVICE_TYPES


def contains_letter(value: str) -> bool:
    """Return True if the string contains at least one alphabetic character (A-Z)."""
    return any(char.isalpha() for char in value)


def parse_asset_tag(qr_code: str) -> ParsedAssetTag:
    normalized = qr_code.strip().upper()
    match = QR_PATTERN.fullmatch(normalized)

    if not match:
        if not SERIAL_PATTERN.fullmatch(normalized):
            raise ValueError(
                "Invalid scan code format. Expected a CRA asset tag or a serial number encoded in QR/barcode form."
            )

        return ParsedAssetTag(
            raw_qr_code=normalized,
            company="N/A",
            location_code="N/A",
            location="N/A",
            device_type_code="N/A",
            device_type="N/A",
            date_acquired="N/A",
            sequence_number="N/A",
        )

    location_code = match.group("location_code")
    device_type_code = match.group("device_type_code")

    raw_date = match.group("date_acquired")
    if raw_date:
        date_acquired = f"{raw_date[:2]}/{raw_date[2:]}"
        sequence_number = match.group("sequence_dated")
    else:
        date_acquired = "N/A"
        # Determine whether it matched the 5-digit or 4-digit sequence
        sequence_number = match.group("sequence_5") or match.group("sequence_4")

    return ParsedAssetTag(
        raw_qr_code=normalized,
        company=match.group("company"),
        location_code=location_code,
        location=LOCATION_MAP[location_code],
        device_type_code=device_type_code,
        device_type=DEVICE_MAP[device_type_code],
        date_acquired=date_acquired,
        sequence_number=sequence_number,
        serial_number="N/A",
    )