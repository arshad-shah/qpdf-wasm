# @arshad-shah/qpdf-wasm

qpdf 12.2.0 compiled to WebAssembly, with a strict TypeScript API for browsers,
Web Workers, and Node.js 20+. The wrapper is MIT licensed. qpdf uses its native
crypto provider; OpenSSL and GnuTLS are disabled. AES-256 uses PDF revision 6.
No GPL or AGPL libraries are linked.

This software is based in part on the work of the Independent JPEG Group.
See `THIRD_PARTY_LICENSES` for qpdf, zlib, and libjpeg-turbo notices.

## Node

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { optimize, encrypt, decrypt, inspect, check } from '@arshad-shah/qpdf-wasm';

const input = new Uint8Array(await readFile('input.pdf'));
const optimized = await optimize(input, {
  objectStreams: 'generate', compressStreams: true,
  recompressFlate: true, removeUnreferenced: true, linearize: false,
});
console.log(optimized.warnings);
await writeFile('optimized.pdf', optimized.bytes);

const secured = await encrypt(input, {
  userPassword: 'reader-password', ownerPassword: 'owner-password',
  permissions: { print: 'full', extract: false, modify: 'none' },
});
console.log(await inspect(secured.bytes, 'reader-password'));
const plain = await decrypt(secured.bytes, 'reader-password');
await check(plain.bytes);
```

## Vite with a worker

Use Vite's `?url` import so the wasm is served from your application's origin.
Keep the expensive synchronous C++ work in a worker. The asynchronous API does
not make native processing yield on the main thread.

`pdf.worker.ts`:

```ts
/// <reference types="vite/client" />
import wasmUrl from '@arshad-shah/qpdf-wasm/qpdf.wasm?url';
import { configure, optimize } from '@arshad-shah/qpdf-wasm';

configure({ wasmUrl });
self.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
  try {
    const result = await optimize(new Uint8Array(data));
    self.postMessage({ bytes: result.bytes, warnings: result.warnings },
      { transfer: [result.bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
```

In your app:

```ts
const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = ({ data }) => console.log(data);
const bytes = await file.arrayBuffer(); // file is a File selected by the user
worker.postMessage(bytes, [bytes]);
```

Alternatively, copy `dist/qpdf.wasm` to your public directory and call
`configure({ wasmUrl: new URL('/qpdf.wasm', location.origin) })`.
`configure({ locateFile: (name, prefix) => ... })` supports custom asset routing.
Vite may show a harmless "module externalized" warning for the Node-only
`node:fs/promises` loader. Browsers use fetch instead.
Node defaults to the wasm adjacent to the generated ES module.

## API

- `run(args, files, runtimeOptions?)` creates a fresh module/MEMFS per call and
  returns `{ exitCode, stdout, stderr, files }`. Stdout is captured as text; binary
  stdout (for example output to `-`) is unsupported. Write to a MEMFS file instead.
  It preserves qpdf exit codes;
  callers of this low-level API decide which codes to accept. Input and returned
  paths are relative to `/work`; nested paths are supported. Standard filesystem
  paths in arguments refer to MEMFS, not the host filesystem.
- `optimize(bytes, options?)`, `encrypt(bytes, options)`, and
  `decrypt(bytes, password)` return `{ bytes, warnings, stdout, stderr }`.
- `inspect(bytes, password?)` returns `{ encrypted, needsPassword, pdfVersion, pageCount,
  warnings, stdout, stderr }`. Without a required user password it returns
  `encrypted: true`, `needsPassword: true`, the PDF header version, and `pageCount: null`.
  Owner-only encryption needs no password to read pages. A supplied wrong password
  throws `WRONG_PASSWORD`.
- `check(bytes, password?)` returns `{ warnings, stdout, stderr }` after qpdf's
  structural check. This checks PDF structure; it does not render pages.
- `QpdfError` exposes `code`, `exitCode`, and the complete CLI `result`.
  Errors retain original loader, filesystem, and JSON failures in `cause`.
  Invalid encryption arguments reject with `INVALID_ARGUMENT`.
  `warnings` is a `string[]`, one entry per non-empty stderr line on exit 3.
  Helpers accept exit 0 and exit 3 (warnings); exit 2 throws `QPDF_ERROR`, or
  `WRONG_PASSWORD` when qpdf reports an invalid password. Loader/runtime failures
  use `WASM_ERROR`. Raw stdout/stderr are available for diagnosis.

For encrypted input, pass `optimize(bytes, { password })` or `check(bytes, password)`,
or decrypt the input first.

Optimisation changes PDF structure and compresses streams without image
downsampling or lossy image recompression. qpdf drops unreachable objects by
default; `removeUnreferenced: false` preserves them. The default optimisation
also removes unused page resources. Size reduction depends on the input.

Encryption requires a nonempty owner password. Permission fields include
`print: 'none' | 'low' | 'full'`,
`modify: 'none' | 'assembly' | 'form' | 'annotate' | 'all'`, and boolean
`extract`, `annotate`, `form`, `assemble`, `modifyOther`. Omitted permissions
use qpdf defaults. Granular flags follow the overall `modify` flag and can
override it. Reader software enforces PDF permissions.

Simple boolean permission intents map to `print: allowed ? 'full' : 'none'`
and `modify: allowed ? 'all' : 'none'`; `extract`, `annotate`, `form`, and
`assemble` accept their boolean intents directly.

The compiled WebAssembly.Module is cached once per resolved wasm URL.
Every call instantiates wasm, which provides filesystem isolation but has
startup and memory costs. No pthreads or SharedArrayBuffer are required.
Passwords remain in the worker/module memory for the lifetime of the call;
JavaScript does not guarantee secure erasure. qpdf uses Emscripten's secure
random device backed by Web Crypto in browsers and Node crypto in Node.

## Build locally

Prerequisites: Git, Node >=20, pnpm 10.11.0, network access. All downloaded native
sources and tools stay under `vendor/` and `.toolchain/` (both gitignored).
`sources.lock.json` pins source releases and SHA256 values; hashes are checked
before extraction on every build. Emscripten is pinned to 4.0.10, and bootstrap
scripts pin the emsdk checkout as well.

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
pnpm.cmd install --frozen-lockfile
pnpm.cmd build
pnpm.cmd test
pnpm.cmd size
pnpm.cmd pack
```

The bootstrap installs portable Python, CMake 3.31.6, and Ninja 1.12.1 inside
`.toolchain`; no global installation or Docker is required.

Linux (Git, Python 3, CMake, Ninja, Node and pnpm on PATH):

```sh
bash scripts/bootstrap.sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm size
pnpm pack
```

`pnpm build:wasm` builds zlib and libjpeg-turbo statically, then libqpdf and its
real CLI. The script adjusts zlib's CMake output names to avoid a duplicate
static archive under Emscripten; no compression or crypto implementation is
replaced. Outputs are `dist/qpdf.js` and `dist/qpdf.wasm`.
`pnpm build:ts` emits the wrapper and type declarations.

Node integration tests generate PDFs in memory and exercise the actual wasm,
including AES-256 R6 permissions, content-preserving decryption, wrong passwords,
size reduction, structural checks, warning exit codes, and isolated filesystems.
For an additional browser worker test with an installed Chrome/Edge executable:

```powershell
$env:BROWSER_EXECUTABLE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
pnpm.cmd test:browser
```

The smoke test serves the ES modules and wasm on localhost and verifies secure
encryption, decryption, inspection, linearization, and checks in a module worker.
Its browser profile and temporary files stay in `.toolchain/`.

CI builds and tests on Linux and reports raw/gzip sizes. The tag publishing
workflow checks that `v<version>` matches package.json, then builds, tests, and
publishes with npm provenance. It uses npm trusted publishing through OIDC (npm >=11.5.1), without an npm token.
The owner publishes 0.1.0 manually first, then configures the trusted publisher
on npmjs.com for this workflow and the `npm` GitHub environment. Nothing is published by local builds.
