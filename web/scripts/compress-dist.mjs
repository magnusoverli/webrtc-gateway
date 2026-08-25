import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const compressibleExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".txt", ".xml"]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(entryPath)));
    } else if (entry.isFile() && compressibleExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files;
}

const files = (await filesUnder(dist)).sort();
for (const file of files) {
  const input = await readFile(file);
  const brotli = brotliCompressSync(input, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
    },
  });
  const gzip = gzipSync(input, { level: 9, mtime: 0 });

  await Promise.all([writeFile(`${file}.br`, brotli), writeFile(`${file}.gz`, gzip)]);
}
