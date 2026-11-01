# TamaPoke custom firmware updates through USB

The web installer can flash a local `ota.bin` or `app.bin` to a Waveshare
ESP32-S3 Touch AMOLED 1.75 that **already runs TamaPoke**. The update goes
through Chrome or Edge over USB. It is not a wireless OTA update.

## Before using the custom installer

1. Make a separate **full 16 MB flash backup** of each device. Save the backup
   outside the board before doing anything else.
2. Confirm the existing 16 MB TamaPoke partition layout. Its app0 slot starts
   at `0x10000` and has room for 3 MB; NVS begins at `0x9000` and FFAT at
   `0x610000`.
3. Confirm the board is booting **app0**. If its OTA boot state selects app1
   at `0x310000`, writing app0 will not update the running firmware. Do not
   guess which slot is active.
4. Use a standard ESP32-S3 **app-only** `.bin` image built for that same
   layout. Do not choose a merged firmware file, a bootloader, a partition
   table, or a sprite file.

## Flash the selected app

1. Open the web installer over HTTPS, or run it from `http://localhost`.
   Use Chrome or Edge on a computer.
2. Under **Custom OTA/app update**, choose the local `ota.bin` or `app.bin`.
3. Read the file check and confirm your backup and partition layout.
4. Click **Install selected app .bin** and choose the board's USB port.
5. **Leave "Erase device" unchecked.** Erasing flash destroys saves.
6. Restart, confirm the firmware runs, and repeat on the second board if
   testing LAN battles. Both boards must use the same LAN protocol version.

The installer checks the image header, ESP32-S3 chip ID, app description, and
3 MB size cap. These checks reject common mistakes. They cannot prove an app
is safe or compatible with the saved data. Stop and verify before flashing if
the active app slot or partition layout is unknown.

For the LAN test firmware, use the app-only `app.bin` from the beta Action's
firmware artifact. Keep a copy of your stable firmware until tests pass.
