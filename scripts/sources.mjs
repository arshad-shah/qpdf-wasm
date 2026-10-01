import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const sources = JSON.parse(await readFile(new URL('../sources.lock.json', import.meta.url)));
await mkdir('vendor', { recursive: true });
for (const source of sources.sources) {
  const path = `vendor/${source.name}.tar.gz`;
  let data;
  try { data = await readFile(path); } catch {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`Download failed: ${source.url}: ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    await writeFile(path, data);
  }
  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== source.sha256) throw new Error(`SHA256 mismatch for ${source.name}: ${hash}`);
  const result = spawnSync('tar', ['-xzf', path, '-C', 'vendor'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Extraction failed: ${source.name}`);
}
