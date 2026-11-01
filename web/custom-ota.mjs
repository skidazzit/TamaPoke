// App-only USB updates for the existing 16 MB ESP32-S3 TamaPoke layout.
// Do not accept merged images: those include padding across the NVS save area.
export const APP_OFFSET = 0x10000;
export const APP_MAX_BYTES = 0x300000;
const ESP_IMAGE_MAGIC = 0xe9;
const ESP32_S3_CHIP_ID = 9;
const ESP_APP_DESC_MAGIC = 0xabcd5432;

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
  // An ESP-IDF/Arduino application has an app description at offset 0x20.
  // Bootloaders and merged full-flash files lack it at this location.
  if (view.getUint32(32, true) !== ESP_APP_DESC_MAGIC)
    throw new Error('Not an app-only OTA image. Do not use a merged firmware file.');

  return true;
}

export function makeCustomAppManifest(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('blob:'))
    throw new Error('The firmware must be a local file.');
  return {
    name: 'TamaPoke custom app update',
    version: 'local app-only image',
    // Our app has no Improv support. False silently erases the whole chip!
    // True shows an unchecked Erase device box. Users must leave it off.
    new_install_prompt_erase: true,
    builds: [{
      chipFamily: 'ESP32-S3',
      improv: false,
      parts: [{ path: fileUrl, offset: APP_OFFSET }],
    }],
  };
}
