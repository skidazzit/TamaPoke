# TamaPoke USB custom app update (beta)

The [web installer](https://skidazzit.github.io/TamaPoke/web/) can install a
local ESP32-S3 app-only `ota.bin` / `app.bin` over USB, without Wi-Fi or a
command-line flasher. It now automatically inspects and backs up **each board**
before it offers a flash button.

## How the guarded custom updater works

1. Use **desktop Chrome or Edge over HTTPS** with a data-capable USB cable.
   Choose an ESP32-S3 **app-only** image (not merged firmware, bootloader,
   partition table, or sprite bundle).
2. Click **1. Connect & inspect board**. Select the correct USB port. The page
   uses Espressif's `esptool-js` and reads the board's flash metadata. It
   refuses any device that does not report:
   - ESP32-S3 with 16 MB detected flash;
   - unencrypted flash, no secure boot, and unrestricted download mode;
   - the original **six exact** TamaPoke partitions: NVS 0x9000/0x5000,
     OTA data 0xE000/0x2000, app0 0x10000/0x300000, app1
     0x310000/0x300000, FFAT 0x610000/0x9E0000, coredump
     0xFF0000/0x10000;
   - a valid, unambiguous OTA selection for **app0**, with a matching app header.
3. Click **2. Save & verify full backup**. Choose a local `.bin` save path in
   the browser picker. The updater reads all **16,777,216 bytes**, writes the
   backup to that file, reopens the saved file, and checks all bytes against
   the flash read. It also checks that the partition and OTA metadata still
   match the earlier inspection. This may take several minutes; don't unplug.
   If saving or verification fails/cancels, flashing remains locked.
4. Click **3. Flash verified app** to write only the selected app image at
   **0x10000** on the **same open serial connection**. A final read rechecks
   the boot metadata. The updater uses `eraseAll: false`, never intentionally
   targets NVS/FFAT/OTA data, and reads the updated app back for comparison.
5. Disconnect and restart the board. Keep the downloaded full-flash backup in
   a safe place. Repeat every step for the other board before a LAN beta test.

The normal **Install TamaPoke** button above this section is a separate tool.
It still has an optional *Erase device* checkbox; **leave that unchecked**
when preserving your pet and settings.

## What the automatic checks cannot guarantee

- OTA metadata identifies the bootloader's selected app, **not with certainty
  the currently running app** if the bootloader fell back due to a failed
  image. This beta refuses uncertain OTA states and any app1 selection. If
  either is reported, stop; it does not try to rewrite OTA metadata.
- A valid ESP32-S3 app header does not prove your custom app is compatible
  with your save format, board peripherals, or SD card contents.
- This process is a **USB app update**, not wireless OTA. There is no
  automatic rollback: preserve the full backup and the original firmware.
- A disconnected cable, electrical fault, or other failure during the
  app write may leave the board unable to boot. The earlier full backup can
  be used with an expert ESP flasher to recover it.
- Your browser must support the native *Save file* picker and allow reopening
  the saved file for verification. Nothing is uploaded to a server.

We have automated tests for the checks and workflow. The USB read/write
sequence still needs testing with a physical Waveshare
ESP32-S3-Touch-AMOLED-1.75 board; treat this feature as **beta** until then.
