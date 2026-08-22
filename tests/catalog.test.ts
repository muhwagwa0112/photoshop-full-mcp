import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { CommandCatalog } from "../src/catalog.js";
import { PhotoshopMcpError } from "../src/errors.js";

test("catalog searches Korean labels and returns stable ids", async () => {
  const catalog = await CommandCatalog.load();
  const matches = catalog.list({ query: "레이어" });
  assert.ok(matches.some((command) => command.id === "layer.create"));
  assert.ok(matches.every((command) => command.id.length > 0));
});

test("catalog validates command-specific args", async () => {
  const catalog = await CommandCatalog.load();
  assert.deepEqual(catalog.validate("document.create", { width: 100, height: 80 }), { width: 100, height: 80 });
  assert.throws(
    () => catalog.validate("document.create", { width: 0, height: 80 }),
    (error) => error instanceof PhotoshopMcpError && error.code === "PRECONDITION_FAILED",
  );
});

test("documented DOM commands are promoted only when a live fixture exists", async () => {
  const catalog = await CommandCatalog.load();
  const candidates = [
    "document.duplicate", "document.resize_canvas", "document.rotate", "layer.group_create",
    "layer.visibility_set", "layer.opacity_set", "selection.invert", "selection.rectangle",
    "text.create", "text.content_set", "path.create_from_selection",
  ];
  for (const id of candidates) {
    const hasFixture = existsSync(resolve("evidence", "live", "commands", `${id}.json`));
    assert.equal(catalog.get(id).status, hasFixture ? "supported" : "unverified");
  }
  assert.deepEqual(catalog.validate("selection.rectangle", { left: 0, top: 0, right: 10, bottom: 20 }), {
    left: 0, top: 0, right: 10, bottom: 20, anti_alias: true,
  });
  assert.throws(() => catalog.validate("layer.opacity_set", { opacity: 101 }), PhotoshopMcpError);
});

test("catalog publishes no supported command without live Photoshop evidence", async () => {
  const catalog = await CommandCatalog.load();
  const allCommands = catalog.list();
  assert.ok(allCommands.length >= 69, "the verified v2 baseline command surface must not shrink");
  assert.equal(new Set(allCommands.map((command) => command.id)).size, allCommands.length, "command ids must remain unique");
  const supported = catalog.list({ status: "supported" });
  const fixtureBacked = allCommands.filter((command) => existsSync(resolve("evidence", "live", "commands", `${command.id}.json`)));
  assert.equal(supported.length, fixtureBacked.length);
  assert.ok(supported.every((command) => existsSync(resolve("evidence", "live", "commands", `${command.id}.json`))));
  const counts = ["supported", "experimental", "requires_user", "unavailable", "unverified"]
    .map((status) => catalog.list({ status: status as "supported" | "experimental" | "requires_user" | "unavailable" | "unverified" }).length);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), catalog.list().length);
  assert.ok(catalog.list({ status: "requires_user" }).length > 0);
  assert.equal(catalog.get("generative.fill").status, "unavailable");
  assert.equal(catalog.get("neural.skin_smoothing").status, "unavailable");
  assert.equal(catalog.get("generative.upscale").status, "experimental");
});

test("unknown command is never treated as supported", async () => {
  const catalog = await CommandCatalog.load();
  assert.throws(
    () => catalog.get("internal.secret_command"),
    (error) => error instanceof PhotoshopMcpError && error.code === "UNSUPPORTED",
  );
});

test("feature inventory classifies broad Photoshop surfaces", async () => {
  const catalog = await CommandCatalog.load();
  const features = catalog.listFeatures();
  const featureDefinitions = JSON.parse(readFileSync(resolve("catalog", "features.json"), "utf8")) as unknown[];
  assert.equal(features.length, featureDefinitions.length, "loaded feature count must match the versioned inventory");
  assert.equal(new Set(features.map((feature) => feature.id)).size, features.length, "feature ids must remain unique");
  assert.ok(features.some((feature) => feature.status === "supported"));
  assert.ok(features.some((feature) => feature.status === "experimental"));
  assert.ok(features.some((feature) => feature.status === "requires_user"));
  assert.ok(features.some((feature) => feature.status === "unavailable"));
  assert.ok(features.filter((feature) => feature.status === "supported").every((feature) => existsSync(resolve("evidence", "live", "features", `${feature.id}.json`))), "supported feature groups require signed live end-to-end evidence");
  assert.ok(features.every((feature) => feature.route.length > 0));
});
