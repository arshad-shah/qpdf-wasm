import createQpdf from './qpdf.js';

export interface RuntimeOptions {
  wasmUrl?: string | URL;
  locateFile?: (path: string, prefix: string) => string;
  /** Optional loader; cached once per resolved wasm URL. */
  compileWasm?: (url: string) => Promise<WebAssembly.Module>;
}
const compiledModules = new Map<string, Promise<WebAssembly.Module>>();
async function compileWasm(url: string): Promise<WebAssembly.Module> {
  const resolved = new URL(url, import.meta.url);
  if (resolved.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return WebAssembly.compile(await readFile(resolved));
  }
  const response = await fetch(resolved);
  if (!response.ok) throw new Error(`Unable to fetch wasm: ${response.status}`);
  return WebAssembly.compile(await response.arrayBuffer());
}
let runtimeOptions: RuntimeOptions = {};
/** Configure before starting a call. Each call captures its own configuration. */
export function configure(options: RuntimeOptions): void { runtimeOptions = { ...options }; }
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  files: Record<string, Uint8Array>;
}
export type ErrorCode = 'WRONG_PASSWORD' | 'QPDF_ERROR' | 'WASM_ERROR' | 'INVALID_ARGUMENT';
export class QpdfError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly result?: RunResult, options?: ErrorOptions) {
    super(message, options);
    this.name = 'QpdfError';
  }
  get exitCode(): number | undefined { return this.result?.exitCode; }
}
function filePath(name: string): string {
  const path = name.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new QpdfError('INVALID_ARGUMENT', `Expected a relative MEMFS file path: ${name}`);
  }
  return `/work/${path}`;
}
/** Raw qpdf CLI results, including nonzero exit codes. Files are relative to /work. */
export async function run(args: string[], files: Record<string, Uint8Array>, options: RuntimeOptions = runtimeOptions): Promise<RunResult> {
  const stdout: string[] = [], stderr: string[] = [];
  const locateFile = options.locateFile ?? (options.wasmUrl ? (path: string, prefix: string) => path.endsWith('.wasm') ? String(options.wasmUrl) : prefix + path : undefined);
  let module;
  try {
    const url = new URL(locateFile ? locateFile('qpdf.wasm', new URL('.', import.meta.url).href) : 'qpdf.wasm', import.meta.url).href;
    let compiled = compiledModules.get(url);
    if (!compiled) {
      compiled = (options.compileWasm ?? compileWasm)(url);
      compiledModules.set(url, compiled);
      void compiled.catch(() => { if (compiledModules.get(url) === compiled) compiledModules.delete(url); });
    }
    const wasm = await compiled;
    module = await createQpdf({ thisProgram: 'qpdf', noInitialRun: true, locateFile,
      instantiateWasm: (imports, receive) => { const instance = new WebAssembly.Instance(wasm, imports); receive(instance, wasm); return instance.exports; },
      print: line => stdout.push(line), printErr: line => stderr.push(line) });
  } catch (cause) { throw new QpdfError('WASM_ERROR', 'Unable to initialize qpdf', undefined, { cause }); }
  try {
  module.FS.mkdirTree('/work');
  module.FS.chdir('/work');
  for (const [name, bytes] of Object.entries(files)) {
    const path = filePath(name);
    module.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    module.FS.writeFile(path, bytes);
  }
  let exitCode: number;
  const hostProcess = globalThis.process;
  const previousExitCode = hostProcess?.exitCode;
  try { exitCode = module.callMain([...args]); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') exitCode = error.status;
    else throw new QpdfError('WASM_ERROR', 'qpdf execution failed', undefined, { cause: error });
  } finally {
    if (hostProcess) hostProcess.exitCode = previousExitCode;
  }
  const output: Record<string, Uint8Array> = Object.create(null);
  function collect(directory: string) {
    for (const name of module!.FS.readdir(directory)) {
      if (name === '.' || name === '..') continue;
      const path = `${directory}/${name}`;
      if (module!.FS.isDir(module!.FS.stat(path).mode)) collect(path);
      else output[path.slice('/work/'.length)] = module!.FS.readFile(path).slice();
    }
  }
  collect('/work');
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), files: output };
  } catch (cause) {
    if (cause instanceof QpdfError) throw cause;
    throw new QpdfError('WASM_ERROR', 'qpdf filesystem operation failed', undefined, { cause });
  }
}
export interface Diagnostics { warnings: string[]; stdout: string; stderr: string; }
export interface PdfResult extends Diagnostics { bytes: Uint8Array; }
function success(result: RunResult): Diagnostics {
  if (result.exitCode !== 0 && result.exitCode !== 3) {
    const code = /invalid password|incorrect password/i.test(result.stderr) ? 'WRONG_PASSWORD' : 'QPDF_ERROR';
    throw new QpdfError(code, result.stderr || `qpdf exited with code ${result.exitCode}`, result);
  }
  return { warnings: result.exitCode === 3 ? result.stderr.split(/\r?\n/).filter(line => line.trim().length > 0) : [], stdout: result.stdout, stderr: result.stderr };
}
async function transform(bytes: Uint8Array, args: string[]): Promise<PdfResult> {
  const result = await run([...args, 'input.pdf', 'output.pdf'], { 'input.pdf': bytes });
  const diagnostics = success(result);
  if (!result.files['output.pdf']) throw new QpdfError('QPDF_ERROR', 'qpdf did not produce output.pdf', result);
  return { bytes: result.files['output.pdf'], ...diagnostics };
}
export interface OptimizeOptions {
  password?: string;
  objectStreams?: 'generate' | 'preserve' | 'disable';
  compressStreams?: boolean;
  recompressFlate?: boolean;
  removeUnreferenced?: boolean;
  linearize?: boolean;
}
export function optimize(bytes: Uint8Array, options: OptimizeOptions = {}): Promise<PdfResult> {
  const args = [`--object-streams=${options.objectStreams ?? 'generate'}`, `--compress-streams=${options.compressStreams === false ? 'n' : 'y'}`];
  if (options.password !== undefined) args.push(`--password=${options.password}`);
  if (options.recompressFlate !== false) args.push('--recompress-flate', '--compression-level=9');
  if (options.removeUnreferenced === false) args.push('--preserve-unreferenced');
  else args.push('--remove-unreferenced-resources=yes');
  if (options.linearize) args.push('--linearize');
  return transform(bytes, args);
}
export interface Permissions {
  print?: 'none' | 'low' | 'full';
  modify?: 'none' | 'assembly' | 'form' | 'annotate' | 'all';
  extract?: boolean;
  annotate?: boolean;
  form?: boolean;
  assemble?: boolean;
  modifyOther?: boolean;
}
export interface EncryptOptions { userPassword: string; ownerPassword: string; permissions?: Permissions; }
export async function encrypt(bytes: Uint8Array, options: EncryptOptions): Promise<PdfResult> {
  if (!options?.ownerPassword) throw new QpdfError('INVALID_ARGUMENT', 'A nonempty ownerPassword is required for secure AES-256 encryption');
  const args = ['--encrypt', `--user-password=${options.userPassword}`, `--owner-password=${options.ownerPassword}`, '--bits=256'];
  const p = options.permissions;
  if (p?.print !== undefined) args.push(`--print=${p.print}`);
  if (p?.modify !== undefined) args.push(`--modify=${p.modify}`);
  for (const [key, flag] of [['extract', 'extract'], ['annotate', 'annotate'], ['form', 'form'], ['assemble', 'assemble'], ['modifyOther', 'modify-other']] as const) {
    if (p?.[key] !== undefined) args.push(`--${flag}=${p[key] ? 'y' : 'n'}`);
  }
  args.push('--');
  return transform(bytes, args);
}
export function decrypt(bytes: Uint8Array, password: string): Promise<PdfResult> {
  return transform(bytes, [`--password=${password}`, '--decrypt']);
}
export interface Inspection extends Diagnostics { encrypted: boolean; needsPassword: boolean; pdfVersion: string; pageCount: number | null; }
/** Encrypted PDFs with a nonempty user password require a password to read their pages. */
export async function inspect(bytes: Uint8Array, password?: string): Promise<Inspection> {
  if (password === undefined) {
    const probe = await run(['--requires-password', 'input.pdf'], { 'input.pdf': bytes });
    if (probe.exitCode === 0) {
      const encrypted = await run(['--is-encrypted', 'input.pdf'], { 'input.pdf': bytes });
      if (encrypted.exitCode !== 0) success(encrypted);
      const header = new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).match(/%PDF-(\d+\.\d+)/);
      if (!header) throw new QpdfError('QPDF_ERROR', 'Missing PDF version header', probe);
      return { encrypted: true, needsPassword: true, pdfVersion: header[1], pageCount: null, warnings: [], stdout: probe.stdout, stderr: probe.stderr };
    }
  }
  const args = ['--json', '--json-key=encrypt', '--json-key=pages', '--json-key=qpdf', '--json-object=trailer'];
  if (password !== undefined) args.push(`--password=${password}`);
  const result = await run([...args, 'input.pdf'], { 'input.pdf': bytes });
  const diagnostics = success(result);
  try {
    const json = JSON.parse(result.stdout) as { encrypt: { encrypted: boolean }; pages: unknown[]; qpdf: [{ pdfversion: string }] };
    return { encrypted: json.encrypt.encrypted, needsPassword: false, pdfVersion: json.qpdf[0].pdfversion, pageCount: json.pages.length, ...diagnostics };
  } catch (cause) { throw new QpdfError('QPDF_ERROR', 'Invalid qpdf inspection JSON', result, { cause }); }
}
export async function check(bytes: Uint8Array, password?: string): Promise<Diagnostics> {
  return success(await run(['--check', ...(password === undefined ? [] : [`--password=${password}`]), 'input.pdf'], { 'input.pdf': bytes }));
}
