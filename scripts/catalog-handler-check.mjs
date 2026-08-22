import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const VALID_FEATURE_STATUSES = new Set(["supported", "experimental", "requires_user", "unavailable", "unverified"]);
const EXECUTABLE_COMMAND_STATUSES = new Set(["supported", "experimental", "requires_user"]);
const VERIFIED_ROUTE_STATUSES = new Set(["supported", "experimental"]);
const UNAVAILABLE_SENTINEL = /^no(?:_|-)/;

function routeComponents(feature) {
  if (typeof feature.route !== "string" || !feature.route.trim()) throw new Error(`Feature ${feature.id} must declare a non-empty route`);
  const routes = feature.route.split("|").map((route) => route.trim());
  if (routes.some((route) => !route)) throw new Error(`Feature ${feature.id} has an empty route component`);
  return routes;
}

function handlerCheck(commands, source) {
  const missing = commands
    .filter((command) => EXECUTABLE_COMMAND_STATUSES.has(command.status))
    .filter((command) => !source.includes(`case "${command.id}"`) && !source.match(new RegExp(`USER_ASSISTED_COMMANDS[^;]*["']${command.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "s")))
    .map((command) => `${command.id} (${command.status})`);
  if (missing.length) throw new Error(`Executable catalog entries without UXP handlers: ${missing.join(", ")}`);

  const stableStart = source.indexOf("async function executeStable(");
  const stableEnd = source.indexOf("\nasync function inModal(", stableStart);
  if (stableStart < 0 || stableEnd < 0) throw new Error("Could not locate the UXP stable command dispatcher");
  const stableCases = [...source.slice(stableStart, stableEnd).matchAll(/case\s+["']([^"']+)["']\s*:/g)].map((match) => match[1]);
  const commandIds = new Set(commands.map((command) => command.id));
  const handlersWithoutCatalog = [...new Set(stableCases)].filter((id) => id !== "verified.batchplay" && !commandIds.has(id));
  if (handlersWithoutCatalog.length) throw new Error(`UXP stable handlers without catalog entries: ${handlersWithoutCatalog.join(", ")}`);
}

function featureRouteCheck(commands, features) {
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const invalidStatuses = features.filter((feature) => !VALID_FEATURE_STATUSES.has(feature.status));
  if (invalidStatuses.length) throw new Error(`Invalid feature status: ${invalidStatuses.map((feature) => feature.id).join(", ")}`);

  const routeErrors = [];
  for (const feature of features) {
    for (const route of routeComponents(feature)) {
      const command = commandById.get(route);
      if (feature.status === "supported" || feature.status === "experimental") {
        if (!command) routeErrors.push(`${feature.id}->${route} is not a catalog command`);
        else if (!VERIFIED_ROUTE_STATUSES.has(command.status)) routeErrors.push(`${feature.id}->${route} has status ${command.status}, expected supported or experimental`);
      } else if (feature.status === "requires_user") {
        if (!command) routeErrors.push(`${feature.id}->${route} is not a catalog command`);
      } else if (feature.status === "unavailable") {
        if (UNAVAILABLE_SENTINEL.test(route)) continue;
        if (!command) routeErrors.push(`${feature.id}->${route} is neither an unavailable catalog command nor an explicit no_* sentinel`);
        else if (command.status !== "unavailable") routeErrors.push(`${feature.id}->${route} has status ${command.status}, expected unavailable`);
      }
    }
  }
  if (routeErrors.length) throw new Error(`Feature route contract errors: ${routeErrors.join("; ")}`);
}

export function checkCatalogHandlers({ commands, features, source }) {
  handlerCheck(commands, source);
  featureRouteCheck(commands, features);
  return { ok: true, commands: commands.length, features: features.length };
}

async function main() {
  const commands = JSON.parse(await readFile(new URL("../catalog/commands.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../apps/uxp-plugin/lib/commands.js", import.meta.url), "utf8");
  const features = JSON.parse(await readFile(new URL("../catalog/features.json", import.meta.url), "utf8"));
  process.stdout.write(`${JSON.stringify(checkCatalogHandlers({ commands, features, source }))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
