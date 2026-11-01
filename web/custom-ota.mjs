// Safety checks for a USB app-only update of the original 16 MB TamaPoke layout.
// These are intentionally strict: unfamiliar boards and ambiguous OTA state
// must not be offered an automatic flash path.
export const FLASH_BYTES = 0x1000000;
export const PARTITION_OFFSET = 0x8000;
export const PARTITION_BYTES = 0x1000;
export const OTADATA_OFFSET = 0xe000;
export const OTADATA_BYTES = 0x2000;
export const APP_OFFSET = 0x10000;
export const APP_MAX_BYTES = 0x300000;

const ESP_IMAGE_MAGIC = 0xe9;
const ESP32_S3_CHIP_ID = 9;
const ESP_APP_DESC_MAGIC = 0xabcd5432;

const EXPECTED_PARTITIONS = [
  ['nvs', 1, 2, 0x9000, 0x5000],
  ['otadata', 1, 0, 0xe000, 0x2000],
  ['app0', 0, 0x10, 0x10000, 0x300000],
  ['app1', 0, 0x11, 0x310000, 0x300000],
  ['ffat', 1, 0x81, 0x610000, 0x9e0000],
  ['coredump', 1, 3, 0xff0000, 0x10000],
];

function bytesOf(data, size, name) {
  if (!(data instanceof Uint8Array) || data.length !== size)
    throw new Error(`Could not read the complete ${name}.`);
  return data;
}

export function checkCustomAppImage(header, fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 40)
    throw new Error('The file is too small to be an ESP32 app.');
  if (fileSize > APP_MAX_BYTES)
    throw new Error('The file exceeds the 3 MB TamaPoke app slot.');
  if (!(header instanceof Uint8Array) || header.byteLength < 36)
    throw new Error('Could not read the ESP32 app header.');

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header[0] !== ESP_IMAGE_MAGIC || header[1] < 1 || header[1] > 16)
    throw new Error('Not an ESP32 firmware image.');
  if (view.getUint16(12, true) !== ESP32_S3_CHIP_ID)
    throw new Error('This app is not built for an ESP32-S3.');
  if (view.getUint32(32, true) !== ESP_APP_DESC_MAGIC)
    throw new Error('Not an app-only OTA image. Do not use a merged firmware file.');
  return true;
}

export function checkFlashSecurity(chipName, flashSize, security) {
  if (typeof chipName !== 'string' || !chipName.startsWith('ESP32-S3'))
    throw new Error('The connected board is not an ESP32-S3.');
  if (flashSize !== '16MB')
    throw new Error('Expected 16 MB flash; this board reports ' + (flashSize || 'unknown size') + '.');
  if (!security || security.chipId !== ESP32_S3_CHIP_ID ||
      !Number.isInteger(security.flashCryptCnt) ||
      security.flashCryptCnt !== 0 ||
      !security.parsedFlags ||
      security.parsedFlags.SECURE_BOOT_EN !== false ||
      security.parsedFlags.SECURE_DOWNLOAD_ENABLE !== false)
    throw new Error('Flash encryption, secure boot, or security state is unsupported. No flash permitted.');
}

export function checkPartitionTable(data) {
  bytesOf(data, PARTITION_BYTES, 'partition table');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  const partitions = [];
  let terminated = false;
  for (let off = 0; off < 0xc00; off += 32) {
    const magic = view.getUint16(off, true);
    if (magic === 0xebeb || magic === 0xffff) {
      terminated = true;
      break;
    }
    if (magic !== 0x50aa)
      throw new Error('Invalid ESP partition table.');
    const label = decoder.decode(data.subarray(off + 12, off + 28)).split('\0')[0];
    partitions.push([
      label, data[off + 2], data[off + 3], view.getUint32(off + 4, true),
      view.getUint32(off + 8, true),
    ]);
    if (view.getUint32(off + 28, true) !== 0)
      throw new Error('Unexpected partition flags.');
  }
  if (!terminated || JSON.stringify(partitions) !== JSON.stringify(EXPECTED_PARTITIONS))
    throw new Error('This is not the exact TamaPoke 16 MB partition layout. Nothing was written.');
  return partitions;
}

// esp_rom_crc32_le(UINT32_MAX, &ota_seq, 4) complements the CRC with seed 0.
// The shipped boot_app0.bin's seq=1 entry has CRC 0x4743989a.
export function otaSequenceCrc(sequence) {
  let crc = 0;
  for (let i = 0; i < 4; i++) {
    crc ^= (sequence >>> (8 * i)) & 0xff;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (~crc) >>> 0;
}

export function checkSelectedAppSlot(data) {
  bytesOf(data, OTADATA_BYTES, 'OTA boot metadata');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entries = [0, 0x1000].map((off) => {
    const seq = view.getUint32(off, true);
    const state = view.getUint32(off + 24, true);
    const crc = view.getUint32(off + 28, true);
    // Espressif's shipped boot_app0.bin writes zero to the first four bytes
    // of the second OTA sector; the rest of that entry remains erased.
    // That zero-sequence sentinel is also an inactive OTA entry.
    const erased = data.subarray(off, off + 32).every((byte) => byte === 0xff) ||
      (seq === 0 && data.subarray(off + 4, off + 32).every((byte) => byte === 0xff));
    if (erased) return { erased: true, valid: false };
    const valid = seq !== 0 && seq !== 0xffffffff &&
      (state === 2 || state === 0xffffffff) && crc === otaSequenceCrc(seq);
    return { erased: false, valid, seq, state };
  });

  // This beta updater handles only the unambiguous initial OTA selection.
  // If both entries are present (including a failed/aborted OTA) we leave all
  // the bootloader's fallback/rollback selection logic to a manual expert.
  const selected = entries.filter((entry) => entry.valid);
  if (selected.length !== 1 || entries.some((entry) => !entry.valid && !entry.erased))
    throw new Error('OTA selection is missing, changed, or ambiguous. No automatic flash.');
  const slot = (selected[0].seq - 1) % 2;
  if (slot !== 0)
    throw new Error('OTA metadata selects app1 (0x310000), not app0. Nothing was written.');
  return { slot, offset: APP_OFFSET, sequence: selected[0].seq };
}

export function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function checkBoardSnapshot(partitions, otadata, activeHeader) {
  checkPartitionTable(partitions);
  const selected = checkSelectedAppSlot(otadata);
  checkCustomAppImage(bytesOf(activeHeader, 40, 'app0 header'), 40);
  return selected;
}
