import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateFromFiles, generateFromModules, RegistryError, stale } from "./registry.js";

// npm run registry:write   regenerates every list of connectors from each connector's own files
// npm run registry:check   exits non-zero when a generated file is out of date

const mode = process.argv[2];
const root = process.cwd();
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const readText = (file: string) => {
  const text = read(file);
  if (text === null) throw new RegistryError(`${file} is missing`);
  return text;
};

try {
  const fromFiles = generateFromFiles(root);
  if (mode === "write") {
    const changed = stale(fromFiles, read);
    for (const [file, content] of fromFiles) writeFileSync(file, content);
    const fromModules = await generateFromModules(root, readText);
    changed.push(...stale(fromModules, read));
    for (const [file, content] of fromModules) writeFileSync(file, content);
    console.log(changed.length ? `registry updated: ${changed.join(", ")}` : "registry already current");
  } else {
    const out = [...stale(fromFiles, read), ...stale(await generateFromModules(root, readText), read)];
    if (out.length) {
      console.error(`generated files are out of date: ${out.join(", ")}\nrun npm run registry:write`);
      process.exit(1);
    }
    console.log("registry ok");
  }
} catch (error) {
  if (!(error instanceof RegistryError)) throw error;
  console.error(error.message);
  process.exit(1);
}
