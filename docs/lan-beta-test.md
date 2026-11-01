# TamaPoke LAN beta — two-board test

This is a test build from `fix/lan-idle-keepalive`. It uses ESP-NOW
(wireless peer-to-peer), not a Wi-Fi router. Both boards must run the same beta:
the battle wire protocol changed from v2 to v3.

## Before flashing

1. Make sure both devices are Waveshare ESP32-S3 Touch AMOLED 1.75 boards,
   with 16 MB flash and 8 MB OPI PSRAM.
2. Save a full flash backup of each device. Use its own USB port and a distinct
   backup filename. Example for macOS, with esptool already installed:

   ```bash
   PORT="/dev/cu.usbmodemXXXX"
   python -m esptool --chip esp32s3 -p "$PORT" -b 460800 read-flash 0x0 0x1000000 TamaPoke-BoardA-Backup.bin
   ```

3. Confirm the current partition scheme. An app-only update is safe only if
   the existing board is already running TamaPoke with the same 16 MB partition
   layout and app slot at `0x10000`. If uncertain, stop and compare the
   existing partition table with `partitions.bin` before writing anything.

## USB beta update — keep your save

For a device already running TamaPoke with the matching partition table:

```bash
PORT="/dev/cu.usbmodemXXXX"
python -m esptool --chip esp32s3 -p "$PORT" -b 460800 write-flash 0x10000 app.bin
```

Do this for each board separately, using the correct port. Do **not** erase the
flash. This writes only the application slot. It does not touch the NVS save
partition at `0x9000` or the FFAT partition.

For a truly blank board only, the four beta parts can be flashed at their
own addresses: `bootloader.bin` at `0x0`, `partitions.bin` at `0x8000`,
`boot_app0.bin` at `0xe000`, and `app.bin` at `0x10000`.
Do not use this route on a device with data you want to keep until the
partition layout and backup have been reviewed.

## Two-device test

1. Start both boards. Enter LAN BATTLE on each within 20 seconds. Select
   HOST on one and JOIN on the other, then choose teams.
2. Once both show READY, **wait 45 seconds** before tapping FIGHT.
   Neither board should show LOST.
3. Start the fight. Have the guest choose a move. Wait **25 seconds**
   before choosing a move on the host. Both devices should stay linked.
4. Finish a battle and wait **45 seconds** before tapping AGAIN.
   Both should return to READY for a rematch.
5. During another match, switch off one board. The other should show
   LOST after its 12-second silence deadline instead of freezing.
6. Repeat with both players selecting HOST, then both selecting JOIN.
   The protocol should still agree on one host.

If the link fails, capture the serial output from each board at 115200 baud.
Keep the lines beginning `ESP-NOW` and the final `rx / tx / fallos /
ajenos / desborde` totals. Remove any personal information before sharing.

## Limits

The protocol unit tests passed, including packet loss and long idle waits.
The radio path and firmware build still need real-board validation.
Do not merge this beta into `main` before these steps pass.
