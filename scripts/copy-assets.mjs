import { cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/catalog/", import.meta.url), { recursive: true });
await cp(new URL("../catalog/commands.json", import.meta.url), new URL("../dist/catalog/commands.json", import.meta.url));
await cp(new URL("../catalog/features.json", import.meta.url), new URL("../dist/catalog/features.json", import.meta.url));
