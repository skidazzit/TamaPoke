import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { checkCustomAppImage, makeCustomAppManifest,
         APP_OFFSET, APP_MAX_BYTES } from './custom-ota.mjs';

const app = readFileSync(new URL('./firmware/app.bin', import.meta.url));
const merged = readFileSync(new URL('./firmware/tamapoke.bin', import.meta.url));
const head = (bytes) => new Uint8Array(bytes.subarray(0, 40));
const rejects = (bytes, size, text) =>
  assert.throws(() => checkCustomAppImage(head(bytes), size), text);

assert.equal(checkCustomAppImage(head(app), app.length), true,
             'the shipped app.bin is a valid ESP32-S3 OTA image');
rejects(merged, merged.length, /app-only OTA image/);
rejects(Buffer.alloc(40), 40, /ESP32 firmware image/);
const wrongChip = Buffer.from(app.subarray(0, 40));
wrongChip[12] = 0;
wrongChip[13] = 0;
rejects(wrongChip, 40, /ESP32-S3/);
rejects(app, APP_MAX_BYTES + 1, /3 MB/);
rejects(app, 10, /too small/);

const manifest = makeCustomAppManifest('blob:https://example.org/test');
assert.equal(manifest.new_install_prompt_erase, true,
             'never silently erase a no-Improv device');
assert.equal(manifest.builds.length, 1);
assert.equal(manifest.builds[0].chipFamily, 'ESP32-S3');
assert.deepEqual(manifest.builds[0].parts, [
  { path: 'blob:https://example.org/test', offset: APP_OFFSET },
], 'the web installer only writes the app slot');
assert.throws(() => makeCustomAppManifest('https://server/full.bin'), /local file/);

// Exercise the actual page handlers without opening a browser or touching USB.
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'the page includes a custom installer module');
const elements = new Map();
const events = new Map();
for (const id of ['custom-file', 'custom-confirm', 'custom-install', 'custom-status']) {
  elements.set(id, {
    hidden: id === 'custom-install', checked: false, disabled: false,
    files: [], textContent: '', addEventListener(event, cb) { this[event] = cb; },
  });
}
const fileInput = elements.get('custom-file');
const confirm = elements.get('custom-confirm');
const installer = elements.get('custom-install');
let urlCount = 0;
const urlObjects = new Map();
const mockURL = {
  createObjectURL(obj) {
    const url = `blob:https://example.org/${++urlCount}`;
    urlObjects.set(url, obj);
    return url;
  },
  revokeObjectURL(url) { urlObjects.delete(url); },
};
runInNewContext(script.replace(/^\s*import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*/, ''), {
  document: { getElementById: (id) => elements.get(id) },
  window: { addEventListener: (event, cb) => events.set(event, cb) },
  navigator: { serial: {} }, URL: mockURL, Blob, Uint8Array,
  checkCustomAppImage, makeCustomAppManifest,
});

fileInput.files = [new File([app], 'ota.bin')];
await fileInput.change();
assert.equal(confirm.disabled, false, 'valid app unlocks the backup checkbox');
assert.equal(installer.hidden, true, 'no flash button before backup confirmation');
confirm.checked = true;
confirm.change();
assert.equal(installer.hidden, false, 'confirmation shows flash button');
const blob = urlObjects.get(installer.manifest);
assert.ok(blob, 'dynamic manifest stays alive until the page closes');
const fromPage = JSON.parse(await blob.text());
assert.equal(fromPage.new_install_prompt_erase, true);
assert.deepEqual(fromPage.builds[0].parts, [{
  path: fromPage.builds[0].parts[0].path, offset: APP_OFFSET,
}]);

fileInput.files = [new File([merged], 'merged.bin')];
await fileInput.change();
assert.equal(installer.hidden, true, 'merged firmware hides the install button');
assert.equal(confirm.disabled, true, 'merged firmware cannot be confirmed');
assert.match(elements.get('custom-status').textContent, /File rejected:/);
events.get('pagehide')();

console.log('custom OTA: app validation and safe manifest passed');
