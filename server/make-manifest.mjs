// Writes extension/manifest.json with the fixed public key so the extension ID is stable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { key, id } = JSON.parse(fs.readFileSync(path.join(root, 'ext-key.json'), 'utf8').replace(/^\uFEFF/, ''));
const manifest = {
  manifest_version: 3,
  name: 'DSH Browser Bridge',
  version: '1.0.0',
  description: 'Lets DeepSeek Harness read and debug your open Chrome tabs through chrome.debugger.',
  key,
  minimum_chrome_version: '116',
  background: { service_worker: 'background.js' },
  action: { default_title: 'DSH Browser Bridge' },
  permissions: ['debugger', 'tabs', 'alarms'],
  host_permissions: ['<all_urls>'],
};
fs.writeFileSync(path.join(root, 'extension', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest written, extension id ${id}`);
