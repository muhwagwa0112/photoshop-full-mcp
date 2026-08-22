import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandDefinition } from "../packages/contracts/src/index.js";
import { PhotoshopMcpError } from "../src/errors.js";
import { assertCommandPrerequisites } from "../src/server.js";

function command(prerequisites: string[]): CommandDefinition {
  return {
    id: "test.command",
    category: "test",
    labels: { en: "Test", ko: "테스트" },
    description: "Test prerequisite contract",
    status: "unverified",
    engine: "uxp_dom",
    minHostVersion: "27.9.0",
    risk: "edit",
    approval: "none",
    prerequisites,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    verification: "state",
    rollback: "none",
  };
}

function rejects(code: PhotoshopMcpError["code"], prerequisites: string[], state: unknown, host?: unknown): void {
  assert.throws(
    () => assertCommandPrerequisites(command(prerequisites), state, host),
    (error) => error instanceof PhotoshopMcpError && error.code === code,
  );
}

const documentState = {
  hasDocument: true,
  activeDocument: { id: 1, title: "PS_MCP_VALIDATION_Test" },
  activeLayer: { id: 2, kind: "pixel" },
};

test("selection, channel and path prerequisites fail closed when state has no positive evidence", () => {
  rejects("PRECONDITION_FAILED", ["document", "selection"], documentState);
  rejects("PRECONDITION_FAILED", ["document", "channel"], documentState);
  rejects("PRECONDITION_FAILED", ["document", "path"], documentState);

  assert.doesNotThrow(() => assertCommandPrerequisites(command(["document", "selection"]), { ...documentState, hasSelection: true }));
  assert.doesNotThrow(() => assertCommandPrerequisites(command(["document", "channel"]), { ...documentState, activeChannels: [{ name: "Alpha 1" }] }));
  assert.doesNotThrow(() => assertCommandPrerequisites(command(["document", "path"]), { ...documentState, pathCount: 1 }));
});

test("text_layer requires explicit text kind or a textItem object", () => {
  rejects("PRECONDITION_FAILED", ["document", "layer", "text_layer"], documentState);
  assert.doesNotThrow(() => assertCommandPrerequisites(command(["document", "layer", "text_layer"]), {
    ...documentState,
    activeLayer: { id: 3, kind: "LayerKind.TEXT" },
  }));
  assert.doesNotThrow(() => assertCommandPrerequisites(command(["document", "layer", "text_layer"]), {
    ...documentState,
    activeLayer: { id: 3, textItem: {} },
  }));
});

test("export_folder requires a positive state or host storage probe", () => {
  rejects("PRECONDITION_FAILED", ["document", "export_folder"], documentState, {});
  assert.doesNotThrow(() => assertCommandPrerequisites(command(["document", "export_folder"]), {
    ...documentState,
    exportFolderConfigured: true,
  }));
  assert.doesNotThrow(() => assertCommandPrerequisites(command(["document", "export_folder"]), documentState, {
    runtimeProbes: { storage: { exportFolderConfigured: true } },
  }));
});

test("online, entitlement and model prerequisites reject absent or unverified capability state", () => {
  rejects("PRECONDITION_FAILED", ["document", "online"], documentState, { gatedCapabilities: { online: { status: "unverified" } } });
  rejects("ENTITLEMENT_UNAVAILABLE", ["document", "entitlement"], documentState, { gatedCapabilities: { entitlement: { status: "unverified" } } });
  rejects("ENTITLEMENT_UNAVAILABLE", ["document", "model"], documentState, { gatedCapabilities: { neuralFilters: { status: "unverified" } } });

  assert.doesNotThrow(() => assertCommandPrerequisites(command(["document", "online", "entitlement", "model"]), documentState, {
    runtimeProbes: { network: { online: true } },
    gatedCapabilities: {
      entitlement: { status: "available" },
      neuralFilters: { available: true },
    },
  }));
});

test("document, layer and unknown prerequisites remain fail closed", () => {
  rejects("NO_DOCUMENT", ["document"], { hasDocument: false });
  rejects("PRECONDITION_FAILED", ["document", "layer"], { hasDocument: true, activeDocument: {} });
  rejects("PRECONDITION_FAILED", ["document", "future_capability"], documentState);
});
