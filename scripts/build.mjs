import { buildSync } from "esbuild";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "index.js");
const tmpfile = join(root, "dist", "index.js.tmp");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

mkdirSync(join(root, "dist"), { recursive: true });
rmSync(tmpfile, { force: true });

try {
  buildSync({
    entryPoints: [join(root, "src", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: tmpfile,
    // Keep node built-ins external; the relay has no runtime npm dependencies.
    packages: "external",
    // Bake the package version into the bundle for `--version`.
    define: { __QODER_TRANSFER_VERSION__: JSON.stringify(pkg.version) },
    banner: {
      js: "#!/usr/bin/env node",
    },
  });
} catch (err) {
  console.error(err);
  rmSync(tmpfile, { force: true });
  process.exit(1);
}

try {
  renameSync(tmpfile, outfile);
} catch {
  // Windows may return EXDEV/EPERM when the target is open; fall back to copy+unlink.
  copyFileSync(tmpfile, outfile);
  unlinkSync(tmpfile);
}

try {
  chmodSync(outfile, 0o755);
} catch {}
