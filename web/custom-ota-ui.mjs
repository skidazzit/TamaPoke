// One Web Serial session for inspection, verified full-flash backup, and write.
// Never hand the inspected device off to another port picker for the flash.
import {
  FLASH_BYTES, PARTITION_OFFSET, PARTITION_BYTES, OTADATA_OFFSET, OTADATA_BYTES,
  APP_OFFSET, checkCustomAppImage, checkFlashSecurity, checkBoardSnapshot,
  sameBytes,
} from './custom-ota.mjs';

const CHUNK_BYTES = 0x40000;

async function readExactly(loader, offset, size, progress) {
  const data = await loader.readFlash(offset, size, (_packet, read) => {
    if (progress) progress(read);
  });
  if (!(data instanceof Uint8Array) || data.length !== size)
    throw new Error('Flash read was incomplete at 0x' + offset.toString(16) + '.');
  return data;
}

async function readSnapshot(loader) {
  const partitions = await readExactly(loader, PARTITION_OFFSET, PARTITION_BYTES);
  const otadata = await readExactly(loader, OTADATA_OFFSET, OTADATA_BYTES);
  const appSector = await readExactly(loader, APP_OFFSET, 0x1000);
  const activeHeader = appSector.slice(0, 40);
  const selected = checkBoardSnapshot(partitions, otadata, activeHeader);
  return { partitions, otadata, activeHeader, selected };
}

function matchesSnapshot(a, b) {
  return sameBytes(a.partitions, b.partitions) &&
    sameBytes(a.otadata, b.otadata) &&
    sameBytes(a.activeHeader, b.activeHeader);
}

export function setupCustomUpdater({
  document, navigator, window,
  loadFlasher = () => import('https://unpkg.com/esptool-js@0.7.0/bundle.js'),
  pickBackupFile = (options) => window.showSaveFilePicker(options),
  confirmFlash = (message) => window.confirm(message),
}) {
  const fileInput = document.getElementById('custom-file');
  const connectButton = document.getElementById('custom-connect');
  const backupButton = document.getElementById('custom-backup');
  const flashButton = document.getElementById('custom-flash');
  const disconnectButton = document.getElementById('custom-disconnect');
  const status = document.getElementById('custom-status');

  let selectedFile = null;
  let transport = null;
  let loader = null;
  let snapshot = null;
  let backupVerified = false;
  let busy = false;
  let finished = false;
  let flashAttempted = false;

  function updateButtons() {
    fileInput.disabled = !!loader || busy;
    connectButton.disabled = busy || !!loader || !selectedFile || finished;
    backupButton.disabled = busy || !loader || !snapshot || backupVerified || finished;
    flashButton.disabled = busy || !loader || !snapshot || !backupVerified ||
      finished || flashAttempted;
    disconnectButton.disabled = busy || !loader;
  }

  function report(message) { status.textContent = message; }

  function progressLabel(prefix, completed, total) {
    report(`${prefix}: ${(100 * completed / total).toFixed(1)}% (${(completed / 1048576).toFixed(2)} / ${(total / 1048576).toFixed(2)} MiB)`);
  }

  async function withBusy(task) {
    if (busy) return;
    busy = true;
    updateButtons();
    try { await task(); }
    catch (error) { report('Stopped safely: ' + (error?.message || String(error))); }
    finally { busy = false; updateButtons(); }
  }

  fileInput.addEventListener('change', () => withBusy(async () => {
    selectedFile = null;
    backupVerified = false;
    snapshot = null;
    const file = fileInput.files?.[0];
    if (!file) { report('No file selected.'); return; }
    if (!file.name.toLowerCase().endsWith('.bin'))
      throw new Error('Choose a .bin app image.');
    const header = new Uint8Array(await file.slice(0, 40).arrayBuffer());
    checkCustomAppImage(header, file.size);
    selectedFile = file;
    report(`${file.name} (${(file.size / 1048576).toFixed(2)} MiB) verified as an ESP32-S3 app image. Connect the board to inspect it.`);
  }));

  connectButton.addEventListener('click', () => withBusy(async () => {
    if (!selectedFile || loader) return;
    if (!('serial' in navigator))
      throw new Error('Chrome or Edge with Web Serial is required.');
    if (typeof window.showSaveFilePicker !== 'function')
      throw new Error('This browser cannot save and verify a flash backup. Use desktop Chrome or Edge.');

    // Web Serial's port picker must run directly in this click handler.
    const port = await navigator.serial.requestPort();
    try {
      const { ESPLoader, Transport } = await loadFlasher();
      transport = new Transport(port, true);
      loader = new ESPLoader({
        transport, baudrate: 460800,
        terminal: { clean() {}, write() {}, writeLine() {} },
        debugLogging: false,
      });
      report('Connecting to the selected board and reading its boot metadata…');
      const chipName = await loader.main();
      const flashSize = await loader.detectFlashSize();
      const security = await loader.getSecurityInfo();
      checkFlashSecurity(chipName, flashSize, security);
      snapshot = await readSnapshot(loader);
      report('Board accepted: ESP32-S3, 16 MB, exact TamaPoke partitions; OTA metadata selects app0 at 0x10000. Next save the complete 16 MB backup.');
    } catch (error) {
      snapshot = null;
      const currentTransport = transport;
      loader = transport = null;
      if (currentTransport) await currentTransport.disconnect().catch(() => {});
      throw error;
    }
  }));

  backupButton.addEventListener('click', () => withBusy(async () => {
    if (!loader || !snapshot || backupVerified) return;
    // The browser requires the user to choose a local save path. Request the
    // picker immediately from this click, before the lengthy USB read begins.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const handle = await pickBackupFile({
      suggestedName: `tamapoke-full-flash-${stamp}.bin`,
      types: [{ description: 'Complete 16 MB ESP32 flash backup',
                accept: { 'application/octet-stream': ['.bin'] } }],
    });
    if (!handle?.createWritable || !handle?.getFile)
      throw new Error('The browser cannot verify the saved backup file.');

    let writable;
    try {
      writable = await handle.createWritable();
      const original = new Uint8Array(FLASH_BYTES);
      for (let offset = 0; offset < FLASH_BYTES; offset += CHUNK_BYTES) {
        const length = Math.min(CHUNK_BYTES, FLASH_BYTES - offset);
        const chunk = await readExactly(loader, offset, length, (received) => {
          progressLabel('Backing up flash', offset + received, FLASH_BYTES);
        });
        original.set(chunk, offset);
        await writable.write(chunk);
      }
      await writable.close();
      writable = null;
      report('Backup saved. Reopening the file to verify all 16 MB…');
      const savedFile = await handle.getFile();
      if (savedFile.size !== FLASH_BYTES ||
          !sameBytes(original, new Uint8Array(await savedFile.arrayBuffer())))
        throw new Error('Saved backup did not match the board; no flash permitted.');

      const fromBackup = {
        partitions: original.slice(PARTITION_OFFSET, PARTITION_OFFSET + PARTITION_BYTES),
        otadata: original.slice(OTADATA_OFFSET, OTADATA_OFFSET + OTADATA_BYTES),
        activeHeader: original.slice(APP_OFFSET, APP_OFFSET + 40),
      };
      checkBoardSnapshot(fromBackup.partitions, fromBackup.otadata, fromBackup.activeHeader);
      if (!matchesSnapshot(snapshot, fromBackup))
        throw new Error('Board metadata changed during backup; no flash permitted.');

      backupVerified = true;
      report('Verified: complete 16 MB backup saved and byte-for-byte checked. App0 is the OTA-selected slot. Flashing is now available for this same connected board.');
    } finally {
      if (writable) await writable.abort().catch(() => {});
    }
  }));

  flashButton.addEventListener('click', () => withBusy(async () => {
    if (!loader || !snapshot || !backupVerified || !selectedFile || finished || flashAttempted) return;
    if (!confirmFlash('Flash the selected app to app0 (0x10000) on this checked board? Your full flash backup has been saved. NVS and FFAT will not be intentionally written.'))
      return;
    report('Rechecking OTA selection and partition layout before writing…');
    const current = await readSnapshot(loader);
    if (!matchesSnapshot(snapshot, current))
      throw new Error('Board metadata changed since the backup. No flash permitted.');
    const image = new Uint8Array(await selectedFile.arrayBuffer());
    checkCustomAppImage(image.subarray(0, 40), image.length);

    // A failed or interrupted write must not silently offer a retry. The user
    // should recover/inspect again instead of programming an uncertain state.
    flashAttempted = true;
    await loader.writeFlash({
      fileArray: [{ data: image, address: APP_OFFSET }],
      flashMode: 'keep', flashFreq: 'keep', flashSize: '16MB',
      eraseAll: false, compress: true,
      reportProgress: (_index, written, total) => progressLabel('Writing app0', written, total),
    });
    report('App written. Reading it back to verify every firmware byte…');
    for (let offset = 0; offset < image.length; offset += CHUNK_BYTES) {
      const remaining = Math.min(CHUNK_BYTES, image.length - offset);
      // Read full flash sectors, while only comparing the selected file bytes.
      const length = Math.ceil(remaining / 0x1000) * 0x1000;
      const block = await readExactly(loader, APP_OFFSET + offset, length, (received) => {
        progressLabel('Verifying app0', Math.min(offset + received, image.length), image.length);
      });
      if (!sameBytes(block.subarray(0, remaining), image.subarray(offset, offset + remaining)))
        throw new Error('Flash verification failed. Do not use the device until recovered from backup.');
    }
    finished = true;
    report('Success: app0 flashed and read-back verified; NVS, FFAT, partition table and OTA data were not targeted. Disconnect and restart the board.');
  }));

  disconnectButton.addEventListener('click', () => withBusy(async () => {
    const currentTransport = transport;
    loader = transport = snapshot = null;
    backupVerified = false;
    flashAttempted = false;
    finished = false;
    if (currentTransport) await currentTransport.disconnect();
    report('Disconnected. Press RESET on the board. Choose a file and connect again for the next board.');
  }));

  updateButtons();
}
