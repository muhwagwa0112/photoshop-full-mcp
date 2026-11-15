import { cp, mkdir, readdir } from "node:fs/promises";

await mkdir(new URL("../dist/catalog/", import.meta.url), { recursive: true });
await cp(new URL("../catalog/commands.json", import.meta.url), new URL("../dist/catalog/commands.json", import.meta.url));
await cp(new URL("../catalog/features.json", import.meta.url), new URL("../dist/catalog/features.json", import.meta.url));

await mkdir(new URL("../dist/workers/", import.meta.url), { recursive: true });
for (const filename of await readdir(new URL("../workers/", import.meta.url))) {
  if (filename.endsWith(".py") || filename === "README.md") {
    await cp(new URL(`../workers/${filename}`, import.meta.url), new URL(`../dist/workers/${filename}`, import.meta.url));
  }
}
await mkdir(new URL("../dist/scripts/", import.meta.url), { recursive: true });
await cp(new URL("./record-controller-profile.mjs", import.meta.url), new URL("../dist/scripts/record-controller-profile.mjs", import.meta.url));
