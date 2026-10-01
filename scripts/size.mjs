import { readdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
for (const name of await readdir('dist')) {
  const bytes = await readFile(`dist/${name}`);
  console.log(`${name}: ${bytes.length} bytes; gzip ${gzipSync(bytes).length} bytes`);
}
