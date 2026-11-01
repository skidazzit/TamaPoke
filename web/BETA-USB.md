# TamaPoke custom USB installer (beta)

This separate test page is for a Waveshare ESP32-S3 Touch AMOLED 1.75 board
that already runs TamaPoke. It does **not** update over Wi-Fi.

## Open the beta page on macOS

1. Unzip the `TamaPoke-custom-USB-installer-beta` artifact.
2. In Terminal, switch to the unzipped folder that contains `index.html`.
3. Run `python3 -m http.server 8000`.
4. Open `http://localhost:8000/` in **Chrome** or **Edge**, not Safari.

The normal **Install TamaPoke** button uses the unchanged stable binaries
shipped with the original installer. To test the LAN beta, use the separate
**Custom OTA/app update** section.

## App-only LAN beta update

1. Back up the **full 16 MB flash** of **each board**. Keep two backup files.
   The USB and backup steps are in `docs/lan-beta-test.md` on the fix branch.
2. Confirm its current 16 MB partition table matches TamaPoke's layout and
   the board boots app0 at offset `0x10000`. If it boots app1 (`0x310000`),
   stop; this tool does not choose the OTA boot slot.
3. Download `TamaPoke-LAN-beta-ESP32S3` from the same GitHub Actions run,
   unzip it, and select **`app.bin`** in the Custom OTA/app section.
4. Review the file check, tick the backup confirmation, and click **Install
   selected app .bin**. Choose your board's USB port.
5. **Leave "Erase device" unchecked** when ESP Web Tools asks. Do not tick it.
6. Repeat with the second board and follow the two-board test guide.

The custom file is checked as an ESP32-S3 app image and must fit the 3 MB
app0 slot. It is loaded only by your browser. A valid image can still contain
bad firmware; a successful file check is not a guarantee that it will boot.
Do not use merged, bootloader, partition, or sprite `.bin` files here.
