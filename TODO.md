# Task: Block numbers-only serial barcodes for Monitors

**Rule:** Only for `Display/Monitor` — the serial number must contain at least one letter (A-Z). Numbers-only serials are rejected.

## Steps
- [x] 1. Add `contains_letter()` helper to `app/parser.py`
- [x] 2. Add validation in `/api/complete-scan` in `app/main.py` (backend authoritative check)
- [x] 3. Add client-side guard in `app/static/scanner.js` (web scanner)
- [x] 4. Add client-side guard in `android/.../MainActivity.kt` (Android app)
- [x] 5. Verified backend syntax is valid (parser.py + main.py)
- [x] 6. Verified Android function indentation is correct
- [x] 7. Rebuilt the Android APK with the new code (successful)

## Summary of changes
- `app/parser.py`: Added `contains_letter(value)` helper.
- `app/main.py`: In `/api/complete-scan`, if the pending asset's `Device Type` is `Display/Monitor` and the serial contains no letters, returns HTTP 400.
- `app/static/scanner.js`: In `completeSerialStep`, if `pendingAsset` is a monitor and the serial has no letters, throws an error before calling the API.
- `android/.../MainActivity.kt`: In `submitSerialScan`, if `pendingAsset` is a monitor and the serial has no letters, shows a toast and aborts the request.

## APK rebuild
- Rebuilt via cached Gradle 8.10.2 (bypassing the corrupted wrapper jar) with `assembleDebug`.
- New APK: `android/InventoryScanner/app/build/outputs/apk/debug/app-debug.apk`
- Build: `BUILD SUCCESSFUL in 20s`, 38 tasks up-to-date.
