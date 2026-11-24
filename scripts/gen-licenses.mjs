// Collect third-party license info into src/assets/licenses.json for the
// app's About tab. Run with `npm run licenses` after changing dependencies.
//
// - Rust crates: every package `cargo metadata` resolves for the app.
// - npm packages: the production dependency tree (what ships in the bundle).
// - Fonts: full license texts (the OFL asks for them to travel with the font).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function cargoPackages() {
  const meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--manifest-path", join(root, "src-tauri/Cargo.toml")], {
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  return meta.packages
    .filter((p) => p.name !== "baton")
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? "See license file" : "Unknown"),
      url: p.repository ?? `https://crates.io/crates/${p.name}`,
      source: "cargo",
    }));
}

function npmPackages() {
  const tree = JSON.parse(execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }));
  const seen = new Map();
  const walk = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      const key = `${name}@${info.version}`;
      if (!info.version || seen.has(key)) continue;
      const pkgFile = join(root, "node_modules", name, "package.json");
      const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf8")) : {};
      const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
      seen.set(key, {
        name,
        version: info.version,
        license: typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "Unknown"),
        url: (repo ?? `https://www.npmjs.com/package/${name}`).replace(/^git\+/, "").replace(/\.git$/, ""),
        source: "npm",
      });
      walk(info.dependencies);
    }
  };
  walk(tree.dependencies);
  return [...seen.values()];
}

const font = (name, license, file) => ({ name, license, text: readFileSync(join(root, file), "utf8").trim() });

const fonts = [
  font("Pretendard", "SIL Open Font License 1.1", "node_modules/pretendard/dist/LICENSE.txt"),
  font("JetBrains Mono", "SIL Open Font License 1.1", "node_modules/@fontsource-variable/jetbrains-mono/LICENSE"),
  font("D2Coding", "SIL Open Font License 1.1", "src/assets/fonts/D2Coding-LICENSE.txt"),
];

const packages = [...cargoPackages(), ...npmPackages()].sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(root, "src/assets/licenses.json"), JSON.stringify({ fonts, packages }, null, 1) + "\n");
console.log(`licenses.json: ${fonts.length} fonts, ${packages.length} packages`);
