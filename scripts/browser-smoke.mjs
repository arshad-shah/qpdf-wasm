import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import assert from 'node:assert/strict';
const browserPath = process.env.BROWSER_EXECUTABLE;
if (!browserPath) throw new Error('Set BROWSER_EXECUTABLE to an installed Chromium/Chrome/Edge executable');
await mkdir('.toolchain/browser', { recursive: true });
await mkdir('.toolchain/tmp', { recursive: true });
const worker = `
import { configure, encrypt, decrypt, inspect, optimize, check } from '/dist/index.js';
configure({ wasmUrl: new URL('/assets/qpdf.wasm', location.origin) });
self.onmessage = async ({ data }) => {
  try {
    const input = new Uint8Array(data);
    const secured = await encrypt(input, { userPassword: 'user', ownerPassword: 'owner' });
    const locked = await inspect(secured.bytes);
    if (!locked.needsPassword || locked.pageCount !== null) throw new Error('Incorrect locked inspection');
    const encrypted = await inspect(secured.bytes, 'user');
    const plain = await decrypt(secured.bytes, 'user');
    const inspected = await inspect(plain.bytes);
    const optimized = await optimize(plain.bytes, { linearize: true });
    const checked = await check(optimized.bytes);
    self.postMessage({ encrypted: encrypted.encrypted, plain: inspected.encrypted, pages: inspected.pageCount, warnings: checked.warnings });
  } catch (e) { self.postMessage({ error: String(e), stack: e.stack }); }
};`;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.end('<!doctype html><title>qpdf smoke</title>'); return; }
    if (path === '/worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(worker); return; }
    const allowed = ['/dist/index.js', '/dist/qpdf.js', '/assets/qpdf.wasm'];
    if (!allowed.includes(path)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    response.end(await readFile(path.endsWith('.wasm') ? 'dist/qpdf.wasm' : path.slice(1)));
  } catch (e) { response.writeHead(500).end(String(e)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  context = await chromium.launchPersistentContext(resolve('.toolchain/browser'), {
    executablePath: browserPath, headless: true,
    env: { ...process.env, TEMP: resolve('.toolchain/tmp'), TMP: resolve('.toolchain/tmp') },
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const doc = await PDFDocument.create(); doc.addPage();
  const bytes = Array.from(await doc.save());
  const result = await page.evaluate(bytes => new Promise((resolve, reject) => {
    const worker = new Worker('/worker.js', { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Worker timed out')); }, 30000);
    worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
    worker.onmessage = ({ data }) => { clearTimeout(timeout); worker.terminate(); resolve(data); };
    const input = new Uint8Array(bytes); worker.postMessage(input.buffer, [input.buffer]);
  }), bytes);
  assert.deepEqual(result, { encrypted: true, plain: false, pages: 1, warnings: [] });
  console.log('Browser module worker: 1 passed, 0 failed (AES-256, decrypt, inspect, linearize, check, explicit wasm URL)');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
