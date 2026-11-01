import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkCustomAppImage, checkFlashSecurity, checkPartitionTable,
  checkSelectedAppSlot, otaSequenceCrc, checkBoardSnapshot, sameBytes,
  APP_OFFSET, APP_MAX_BYTES, FLASH_BYTES, PARTITION_OFFSET, OTADATA_OFFSET,
} from './custom-ota.mjs';
import { setupCustomUpdater } from './custom-ota-ui.mjs';

const app = readFileSync(new URL('./firmware/app.bin', import.meta.url));
const merged = readFileSync(new URL('./firmware/tamapoke.bin', import.meta.url));
const partitionImage = readFileSync(new URL('./firmware/partitions.bin', import.meta.url));
const partitions = new Uint8Array(0x1000).fill(0xff);
partitions.set(partitionImage);
const otadata = readFileSync(new URL('./firmware/boot_app0.bin', import.meta.url));
const head = (bytes) => new Uint8Array(bytes.subarray(0, 40));
const rejects = (bytes, size, text) =>
  assert.throws(() => checkCustomAppImage(head(bytes), size), text);

assert.equal(checkCustomAppImage(head(app), app.length), true);
rejects(merged, merged.length, /app-only OTA image/);
rejects(Buffer.alloc(40), 40, /ESP32 firmware image/);
const wrongChip = Buffer.from(app.subarray(0, 40));
wrongChip[12] = wrongChip[13] = 0;
rejects(wrongChip, 40, /ESP32-S3/);
rejects(app, APP_MAX_BYTES + 1, /3 MB/);
rejects(app, 10, /too small/);

assert.equal(otaSequenceCrc(1), 0x4743989a, 'match the official shipped boot_app0 CRC');
assert.equal(checkPartitionTable(new Uint8Array(partitions)).length, 6);
assert.deepEqual(checkSelectedAppSlot(new Uint8Array(otadata)),
                 { slot: 0, offset: APP_OFFSET, sequence: 1 });
assert.deepEqual(checkBoardSnapshot(new Uint8Array(partitions), new Uint8Array(otadata), head(app)),
                 { slot: 0, offset: APP_OFFSET, sequence: 1 });
assert.ok(sameBytes(app, app));
assert.equal(sameBytes(app, merged), false);

const badTable = Uint8Array.from(partitions);
badTable[0x80 + 4] ^= 0x10; // FFAT moved from 0x610000
assert.throws(() => checkPartitionTable(badTable), /exact TamaPoke/);
const flagsTable = Uint8Array.from(partitions);
flagsTable[28] = 1;
assert.throws(() => checkPartitionTable(flagsTable), /partition flags/);
const app1 = Uint8Array.from(otadata);
new DataView(app1.buffer).setUint32(0, 2, true);
new DataView(app1.buffer).setUint32(28, otaSequenceCrc(2), true);
assert.throws(() => checkSelectedAppSlot(app1), /selects app1/);
const badCrc = Uint8Array.from(otadata);
badCrc[28] ^= 0xff;
assert.throws(() => checkSelectedAppSlot(badCrc), /ambiguous/);
const twoValid = Uint8Array.from(otadata);
twoValid.set(twoValid.subarray(0, 32), 0x1000);
assert.throws(() => checkSelectedAppSlot(twoValid), /ambiguous/);
const blank = new Uint8Array(0x2000).fill(0xff);
assert.throws(() => checkSelectedAppSlot(blank), /ambiguous/);
const security = { chipId: 9, flashCryptCnt: 0,
  parsedFlags: { SECURE_BOOT_EN: false, SECURE_DOWNLOAD_ENABLE: false } };
checkFlashSecurity('ESP32-S3', '16MB', security);
assert.throws(() => checkFlashSecurity('ESP32-C3', '16MB', security), /ESP32-S3/);
assert.throws(() => checkFlashSecurity('ESP32-S3', '8MB', security), /16 MB/);
assert.throws(() => checkFlashSecurity('ESP32-S3', '16MB',
  { ...security, flashCryptCnt: 1 }), /security state/);

// End-to-end browser workflow simulation. No USB hardware or writes outside
// this simulated 16 MB flash array are used.
function fixture({ layout = partitions, ota = otadata, failBackup = false,
                   failVerification = false, badSecurity = false,
                   corruptWrite = false } = {}) {
  const board = new Uint8Array(FLASH_BYTES).fill(0xff);
  board.set(layout, PARTITION_OFFSET);
  board.set(ota, OTADATA_OFFSET);
  board.set(app, APP_OFFSET);
  const originalNvs = board.slice(0x9000, 0xe000);
  const elements = new Map();
  for (const id of ['custom-file', 'custom-connect', 'custom-backup',
                    'custom-flash', 'custom-disconnect', 'custom-status']) {
    elements.set(id, {
      disabled: true, textContent: '', files: [],
      addEventListener(event, listener) { this[event] = listener; },
    });
  }

  const calls = { ports: 0, writes: [], backups: 0, reopens: 0, disconnects: 0 };
  const savedChunks = [];
  let savedBytes = null;
  const handle = {
    async createWritable() {
      if (failBackup) throw new Error('User canceled saving the backup');
      return {
        async write(bytes) { savedChunks.push(Uint8Array.from(bytes)); },
        async close() {
          savedBytes = new Uint8Array(FLASH_BYTES);
          let cursor = 0;
          for (const b of savedChunks) { savedBytes.set(b, cursor); cursor += b.length; }
          assert.equal(cursor, FLASH_BYTES);
        },
        async abort() {},
      };
    },
    async getFile() {
      calls.reopens++;
      const bytes = Uint8Array.from(savedBytes);
      if (failVerification) bytes[1234] ^= 0xff;
      return new File([bytes], 'backup.bin');
    },
  };

  class FakeTransport {
    constructor(port) { assert.equal(port.kind, 'selected-board'); }
    async disconnect() { calls.disconnects++; }
  }
  class FakeLoader {
    async main() { return 'ESP32-S3'; }
    async detectFlashSize() { return '16MB'; }
    async getSecurityInfo() {
      return badSecurity ? { ...security, flashCryptCnt: 1 } : security;
    }
    async readFlash(offset, count, cb) {
      const data = board.slice(offset, offset + count);
      assert.equal(data.length, count, 'board has requested range');
      if (cb) cb(data, count, count);
      return data;
    }
    async writeFlash(options) {
      assert.equal(options.eraseAll, false);
      assert.equal(options.fileArray.length, 1);
      assert.equal(options.fileArray[0].address, APP_OFFSET);
      calls.writes.push(options);
      board.set(options.fileArray[0].data, APP_OFFSET);
      if (corruptWrite) board[APP_OFFSET + 2048] ^= 0xff;
      options.reportProgress(0, options.fileArray[0].data.length,
                             options.fileArray[0].data.length);
    }
  }
  const win = {
    showSaveFilePicker() {},
    confirm(message) { assert.match(message, /full flash backup/); return true; },
  };
  const nav = { serial: { async requestPort() {
    calls.ports++;
    return { kind: 'selected-board' };
  } } };
  setupCustomUpdater({
    document: { getElementById: (id) => elements.get(id) },
    navigator: nav, window: win,
    loadFlasher: async () => ({ ESPLoader: FakeLoader, Transport: FakeTransport }),
    pickBackupFile: async () => { calls.backups++; return handle; },
  });
  return {
    board, calls, originalNvs, elements,
    input: elements.get('custom-file'),
    connect: elements.get('custom-connect'),
    backup: elements.get('custom-backup'),
    flash: elements.get('custom-flash'),
    status: elements.get('custom-status'),
  };
}

async function chooseAndInspect(t) {
  assert.equal(t.connect.disabled, false, 'inspect must be available before choosing firmware');
  t.input.files = [new File([app], 'ota.bin')];
  await t.input.change();
  assert.equal(t.connect.disabled, false);
  assert.equal(t.flash.disabled, true, 'flash initially locked');
  await t.connect.click();
}

const inspectFirst = fixture();
assert.equal(inspectFirst.connect.disabled, false, 'connect enabled immediately');
assert.equal(inspectFirst.flash.disabled, true, 'flash locked without a firmware file');
await inspectFirst.connect.click();
assert.equal(inspectFirst.backup.disabled, false, 'board can be backed up before selecting an app');
await inspectFirst.backup.click();
assert.equal(inspectFirst.flash.disabled, true, 'backup does not bypass firmware selection');
assert.equal(inspectFirst.input.disabled, false, 'file picker remains usable after backing up');
inspectFirst.input.files = [new File([app], 'ota.bin')];
await inspectFirst.input.change();
assert.equal(inspectFirst.flash.disabled, false, 'choosing firmware after backup unlocks flash');
await inspectFirst.flash.click();
assert.equal(inspectFirst.calls.writes.length, 1, 'inspect-first workflow flashes once');

const happy = fixture();
await chooseAndInspect(happy);
assert.equal(happy.calls.ports, 1);
assert.equal(happy.backup.disabled, false, 'valid board allows backing up');
assert.equal(happy.flash.disabled, true, 'inspecting alone cannot flash');
assert.equal(happy.calls.writes.length, 0);
await happy.backup.click();
assert.equal(happy.calls.backups, 1);
assert.equal(happy.calls.reopens, 1, 'must reopen saved backup to verify');
assert.equal(happy.flash.disabled, false, 'flash unlocks after 16 MB verified backup');
await happy.flash.click();
assert.equal(happy.calls.writes.length, 1, 'only the inspected board is written');
assert.ok(sameBytes(happy.board.slice(0x9000, 0xe000), happy.originalNvs),
          'NVS is unaffected');
assert.match(happy.status.textContent, /Success: app0 flashed and read-back verified/);
assert.equal(happy.flash.disabled, true, 'no second flash without new session');

const wrongLayout = fixture({ layout: badTable });
await chooseAndInspect(wrongLayout);
assert.match(wrongLayout.status.textContent, /not the exact TamaPoke/);
assert.equal(wrongLayout.flash.disabled, true);
assert.equal(wrongLayout.backup.disabled, true);
assert.equal(wrongLayout.calls.writes.length, 0);

const otherSlot = fixture({ ota: app1 });
await chooseAndInspect(otherSlot);
assert.match(otherSlot.status.textContent, /selects app1/);
assert.equal(otherSlot.flash.disabled, true);

const secureBoard = fixture({ badSecurity: true });
await chooseAndInspect(secureBoard);
assert.match(secureBoard.status.textContent, /security state/);
assert.equal(secureBoard.flash.disabled, true);

const canceled = fixture({ failBackup: true });
await chooseAndInspect(canceled);
await canceled.backup.click();
assert.match(canceled.status.textContent, /canceled/);
assert.equal(canceled.flash.disabled, true);
assert.equal(canceled.calls.writes.length, 0);

const corruptBackup = fixture({ failVerification: true });
await chooseAndInspect(corruptBackup);
await corruptBackup.backup.click();
assert.match(corruptBackup.status.textContent, /did not match/);
assert.equal(corruptBackup.flash.disabled, true);
assert.equal(corruptBackup.calls.writes.length, 0);

const corruptFlash = fixture({ corruptWrite: true });
await chooseAndInspect(corruptFlash);
await corruptFlash.backup.click();
await corruptFlash.flash.click();
assert.match(corruptFlash.status.textContent, /Flash verification failed/);
assert.equal(corruptFlash.flash.disabled, true, 'no retry of uncertain flash state');

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
assert.match(html, /setupCustomUpdater\(\{ document, navigator, window \}\)/);
assert.match(html, /id="custom-backup"/);
assert.match(html, /id="custom-flash"/);
assert.doesNotMatch(html, /id="custom-confirm"/);
assert.doesNotMatch(html, /id="custom-install"/);

console.log('custom OTA: image, partition, OTA state, security, full backup and flash gate passed');
