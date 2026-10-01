import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { check, decrypt, encrypt, inspect, optimize, QpdfError, run } from '../dist/index.js';

async function fixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const content = new TextEncoder().encode('0 0 0 rg\n' + '10 10 20 20 re f\n'.repeat(2000));
  const stream = PDFRawStream.of(doc.context.obj({ Length: PDFNumber.of(content.length) }), content);
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  return doc.save({ useObjectStreams: false });
}
async function content(bytes: Uint8Array): Promise<string> {
  const json = await run(['--json', '--json-key=pages', 'input.pdf'], { 'input.pdf': bytes });
  expect(json.exitCode).toBe(0);
  const reference = JSON.parse(json.stdout).pages[0].contents[0].split(' ').slice(0, 2).join(',');
  const result = await run([`--show-object=${reference}`, '--filtered-stream-data', 'input.pdf'], { 'input.pdf': bytes });
  expect(result.exitCode).toBe(0);
  return result.stdout;
}
describe('real qpdf wasm', () => {
  it('runs the pinned native CLI', async () => {
    const result = await run(['--version'], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('qpdf version 12.2.0');
  });
  it('encrypts with AES-256 R6 and preserves page count/content on decrypt', async () => {
    const input = await fixture();
    const encrypted = await encrypt(input, { userPassword: 'user', ownerPassword: 'owner', permissions: { extract: false, print: 'low', annotate: false } });
    const details = await run(['--password=user', '--show-encryption', 'input.pdf'], { 'input.pdf': encrypted.bytes });
    expect(details.stdout).toContain('R = 6');
    expect(details.stdout).toContain('AESv3');
    expect(details.stdout).toContain('extract for any purpose: not allowed');
    const output = await decrypt(encrypted.bytes, 'user');
    expect((await inspect(output.bytes)).pageCount).toBe(1);
    expect((await inspect(output.bytes)).encrypted).toBe(false);
    expect(await content(output.bytes)).toBe(await content(input));
    await check(output.bytes);
  });
  it('maps wrong passwords to WRONG_PASSWORD', async () => {
    const encrypted = await encrypt(await fixture(), { userPassword: 'correct', ownerPassword: 'owner' });
    const previous = process.exitCode;
    try {
      process.exitCode = 7;
      await expect(decrypt(encrypted.bytes, 'wrong')).rejects.toMatchObject({ code: 'WRONG_PASSWORD', exitCode: 2 });
      expect(process.exitCode).toBe(7);
    } finally { process.exitCode = previous; }
  });
  it('shrinks uncompressed streams and passes structural checks', async () => {
    const input = await fixture();
    const output = await optimize(input, { recompressFlate: true, removeUnreferenced: true });
    expect(output.bytes.length).toBeLessThan(input.length / 2);
    expect((await check(output.bytes)).warnings).toEqual([]);
    expect(await content(output.bytes)).toBe(await content(input));
  });
  it('inspects plain and encrypted documents', async () => {
    const input = await fixture();
    expect(await inspect(input)).toMatchObject({ encrypted: false, needsPassword: false, pdfVersion: '1.7', pageCount: 1 });
    const encrypted = await encrypt(input, { userPassword: 'user', ownerPassword: 'owner' });
    expect(await inspect(encrypted.bytes, 'user')).toMatchObject({ encrypted: true, pageCount: 1 });
    expect(await inspect(encrypted.bytes)).toMatchObject({ encrypted: true, needsPassword: true, pdfVersion: '1.7', pageCount: null });
    await expect(inspect(encrypted.bytes, 'wrong')).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
    const ownerOnly = await encrypt(input, { userPassword: '', ownerPassword: 'owner' });
    expect(await inspect(ownerOnly.bytes)).toMatchObject({ encrypted: true, needsPassword: false, pageCount: 1 });
    expect((await optimize(encrypted.bytes, { password: 'user' })).bytes.length).toBeGreaterThan(0);
    expect((await check(encrypted.bytes, 'user')).warnings).toEqual([]);
  });
  it('rejects invalid encryption arguments asynchronously with a typed error', async () => {
    await expect(encrypt(await fixture(), { userPassword: '', ownerPassword: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('compiles once for sequential calls while retaining fresh filesystems', async () => {
    const compileWasm = vi.fn(async () => WebAssembly.compile(await readFile(new URL('../dist/qpdf.wasm', import.meta.url))));
    const options = { wasmUrl: new URL('../dist/qpdf.wasm?cache-test', import.meta.url), compileWasm };
    const first = await run(['--version'], { marker: new Uint8Array([1]) }, options);
    const second = await run(['--version'], {}, options);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(compileWasm).toHaveBeenCalledTimes(1);
    expect(second.files.marker).toBeUndefined();
  });
  it('retains loader and filesystem errors as causes', async () => {
    const cause = new Error('loader failed');
    await expect(run([], {}, { wasmUrl: 'failed.wasm', compileWasm: async () => { throw cause; } })).rejects.toMatchObject({ code: 'WASM_ERROR', cause });
    await expect(run(['--version'], { 'a': new Uint8Array(), 'a/b': new Uint8Array() })).rejects.toMatchObject({ code: 'WASM_ERROR', cause: expect.anything() });
  });
  it('retains inspection JSON errors as causes', async () => {
    const input = await fixture();
    const cause = new SyntaxError('invalid inspection JSON');
    const original = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (typeof text === 'string' && text.includes('"encrypt"')) throw cause;
      return original(text, reviver);
    });
    try {
      await expect(inspect(input)).rejects.toMatchObject({ code: 'QPDF_ERROR', cause });
    } finally { spy.mockRestore(); }
  });
  it('isolates files across concurrent module instances', async () => {
    const results = await Promise.all([run(['--version'], { 'nested/a': new Uint8Array([1]) }), run(['--version'], {})]);
    expect(results[0].files['nested/a']).toEqual(new Uint8Array([1]));
    expect(results[1].files['nested/a']).toBeUndefined();
  });
  it('surfaces exit 3 warnings as success', async () => {
    const input = await fixture();
    const text = new TextDecoder().decode(input).replace(/startxref\s+\d+/, 'startxref\n0');
    const damaged = new TextEncoder().encode(text);
    const raw = await run(['--check', 'input.pdf'], { 'input.pdf': damaged });
    expect(raw.exitCode).toBe(3);
    const previous = process.exitCode;
    const checked = await check(damaged);
    expect(process.exitCode).toBe(previous);
    expect(checked.warnings).toEqual(checked.stderr.split(/\r?\n/).filter(line => line.trim().length > 0));
    expect(checked.warnings.length).toBeGreaterThan(1);
    expect(checked.warnings.length).toBeGreaterThan(0);
    const optimized = await optimize(damaged);
    expect(optimized.warnings.length).toBeGreaterThan(0);
    await check(optimized.bytes);
  });
  it('maps malformed PDFs to QPDF_ERROR', async () => {
    await expect(check(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(QpdfError);
    await expect(check(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: 'QPDF_ERROR', exitCode: 2 });
  });
});
