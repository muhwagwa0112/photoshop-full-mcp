import assert from "node:assert/strict";
import { test } from "node:test";

const checker = await import("../scripts/catalog-handler-check.mjs") as {
  checkCatalogHandlers: (input: { commands: Array<Record<string, unknown>>; features: Array<Record<string, unknown>>; source: string }) => { ok: boolean };
};

const source = `async function executeStable() { switch (id) { case "command.supported": break; case "command.experimental": break; case "command.unavailable": break; } }
async function inModal() {}`;
const commands = [
  { id: "command.supported", status: "supported" },
  { id: "command.experimental", status: "experimental" },
  { id: "command.unavailable", status: "unavailable" },
];

test("feature routes fail closed by feature status", () => {
  const checked = checker.checkCatalogHandlers({
    commands,
    source,
    features: [
      { id: "supported.aggregate", status: "supported", route: "command.supported|command.experimental" },
      { id: "unavailable.command", status: "unavailable", route: "command.unavailable" },
      { id: "unavailable.sentinel", status: "unavailable", route: "no_public_uxp_contract" },
      { id: "user.assisted", status: "requires_user", route: "command.supported" },
    ],
  });
  assert.equal(checked.ok, true);
});

test("supported features cannot route to missing or non-promoted commands", () => {
  assert.throws(
    () => checker.checkCatalogHandlers({ commands, source, features: [{ id: "bad.supported", status: "supported", route: "command.unavailable|missing.command" }] }),
    /bad\.supported->command\.unavailable has status unavailable.*bad\.supported->missing\.command is not a catalog command/,
  );
});

test("unavailable features require unavailable commands or explicit no_* sentinels", () => {
  assert.throws(
    () => checker.checkCatalogHandlers({ commands, source, features: [{ id: "bad.unavailable", status: "unavailable", route: "command.supported|opaque_route" }] }),
    /bad\.unavailable->command\.supported has status supported.*bad\.unavailable->opaque_route is neither an unavailable catalog command nor an explicit no_\* sentinel/,
  );
});

test("feature routes reject empty components", () => {
  assert.throws(
    () => checker.checkCatalogHandlers({ commands, source, features: [{ id: "bad.empty", status: "supported", route: "command.supported|" }] }),
    /bad\.empty has an empty route component/,
  );
});
