import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";

const auditModule = await import("../scripts/inventory-evidence-audit.mjs") as {
  auditInventory: (options?: Record<string, unknown>) => Promise<any>;
  auditInventoryData: (input: Record<string, unknown>) => any;
  catalogContractDigest: (definition: Record<string, unknown>) => string;
  evidenceReceiptPayload: (fixture: Record<string, unknown>) => Record<string, unknown>;
  evaluatePromotion: (report: any, commandId: string) => any;
};

const signingKeys = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});

function command(status = "unverified") {
  return {
    id: "layer.fixture_test",
    category: "layer",
    labels: { en: "Fixture", ko: "픽스처" },
    status,
    engine: "uxp_dom",
    minHostVersion: "27.9.0",
    risk: "edit",
    approval: "none",
    prerequisites: ["document", "layer"],
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object" },
    verification: "preview",
    rollback: "history"
  };
}

function fixture(definition: Record<string, any>, transactionId = "11111111-1111-4111-8111-111111111111") {
  const requestId = "33333333-3333-4333-8333-333333333333";
  const receipt: Record<string, any> = {
    schemaVersion: 1,
    kind: "command",
    commandId: definition.id,
    catalogContractSha256: auditModule.catalogContractDigest(definition),
    capturedAt: "2026-08-22T00:00:00.000Z",
    host: { application: "Photoshop", appVersion: "27.9.0", connectedAtCapture: true },
    fixture: {
      isolatedDocument: true,
      temporaryDocumentClosed: true,
      executionPassed: true,
      stateVerified: true,
      undoRoundTripVerified: true,
      previewVerified: true
    },
    result: "passed",
    provenance: {
      version: 1,
      method: "live-mcp-stdio-v1",
      transactionId,
      requestId,
      serverId: "44444444-4444-4444-8444-444444444444",
      steps: {
        hostDescribe: true,
        validation: true,
        preview: true,
        undo: true,
        tempDocumentClose: true,
        targetRequestId: requestId,
        undoRequestId: "66666666-6666-4666-8666-666666666666",
        closeRequestId: "55555555-5555-4555-8555-555555555555",
        beforeStateSha256: "a".repeat(64),
        afterStateSha256: "b".repeat(64),
        finalStateSha256: "c".repeat(64),
        previewBeforeSha256: "d".repeat(64),
        previewAfterSha256: "e".repeat(64),
        previewAfterUndoSha256: "d".repeat(64)
      }
    }
  };
  receipt.provenance.signature = sign(null, Buffer.from(JSON.stringify(auditModule.evidenceReceiptPayload(receipt))), signingKeys.privateKey).toString("base64");
  return receipt;
}

test("repository inventory audit is internally consistent and counts current signed evidence", async () => {
  const report = await auditModule.auditInventory();
  assert.equal(report.ok, true);
  assert.equal(report.summary.commands >= 45, true);
  assert.equal(report.summary.features >= 42, true);
  assert.equal(report.summary.commandFixturesValid >= 1, true);
  assert.equal(report.liveHost.connected, false);
});

test("supported promotion fails when a live fixture is absent", () => {
  const definition = command("supported");
  const report = auditModule.auditInventoryData({
    commands: [definition],
    features: [],
    handlerSource: 'switch (id) { case "layer.fixture_test": break; }'
  });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue: any) => issue.code === "SUPPORTED_LIVE_EVIDENCE_MISSING"));
});

test("promotion remains blocked with valid evidence when the current live host is disconnected", () => {
  const definition = command("unverified");
  const report = auditModule.auditInventoryData({
    commands: [definition],
    features: [],
    handlerSource: 'switch (id) { case "layer.fixture_test": break; }',
    commandFixtures: { [definition.id]: fixture(definition) },
    liveHostReport: { bridge: { connected: false } },
    trustedPublicKey: signingKeys.publicKey
  });
  const promotion = auditModule.evaluatePromotion(report, definition.id);
  assert.equal(promotion.ok, false);
  assert.ok(promotion.blockers.some((blocker: any) => blocker.code === "LIVE_HOST_DISCONNECTED"));
});

test("promotion accepts only signed matching evidence plus a connected Photoshop identity", () => {
  const definition = command("unverified");
  const report = auditModule.auditInventoryData({
    commands: [definition],
    features: [],
    handlerSource: 'switch (id) { case "layer.fixture_test": break; }',
    commandFixtures: { [definition.id]: fixture(definition) },
    trustedPublicKey: signingKeys.publicKey,
    liveHostReport: {
      bridge: { connected: true, serverId: "44444444-4444-4444-8444-444444444444" },
      runtime: { app: "Photoshop", appVersion: "27.9.0", locale: "ko_KR", pluginVersion: "2.0.0" }
    }
  });
  assert.equal(auditModule.evaluatePromotion(report, definition.id).ok, true);
});

test("promotion rejects a signed receipt replayed against another live bridge identity", () => {
  const definition = command("unverified");
  const report = auditModule.auditInventoryData({
    commands: [definition],
    features: [],
    handlerSource: 'case "layer.fixture_test":',
    commandFixtures: { [definition.id]: fixture(definition) },
    trustedPublicKey: signingKeys.publicKey,
    liveHostReport: {
      bridge: { connected: true, serverId: "77777777-7777-4777-8777-777777777777" },
      runtime: { app: "Photoshop", appVersion: "27.9.0" }
    }
  });
  const promotion = auditModule.evaluatePromotion(report, definition.id);
  assert.equal(promotion.ok, false);
  assert.ok(promotion.blockers.some((blocker: any) => blocker.code === "LIVE_HOST_PROVENANCE_MISMATCH"));
});

test("fixture digest drift invalidates previously recorded evidence", () => {
  const definition = command("supported");
  const recorded = fixture(definition);
  definition.inputSchema = { type: "object", additionalProperties: false, properties: { changed: { type: "boolean" } } };
  const report = auditModule.auditInventoryData({
    commands: [definition],
    features: [],
    handlerSource: 'switch (id) { case "layer.fixture_test": break; }',
    commandFixtures: { [definition.id]: recorded },
    trustedPublicKey: signingKeys.publicKey
  });
  assert.equal(report.ok, false);
  assert.ok(report.commands[0].fixture.problems.includes("catalog contract digest mismatch"));
});

test("self-asserted unsigned evidence is rejected", () => {
  const definition = command("supported");
  const unsigned = fixture(definition);
  delete unsigned.provenance;
  const report = auditModule.auditInventoryData({
    commands: [definition],
    features: [],
    handlerSource: 'case "layer.fixture_test":',
    commandFixtures: { [definition.id]: unsigned },
    trustedPublicKey: signingKeys.publicKey
  });
  assert.equal(report.ok, false);
  assert.ok(report.commands[0].fixture.problems.includes("live MCP provenance is missing"));
  assert.ok(report.commands[0].fixture.problems.includes("evidence signature is invalid or trust key is missing"));
});

test("signed evidence tampering is rejected", () => {
  const definition = command("supported");
  const tampered = fixture(definition);
  tampered.host.appVersion = "99.0.0";
  const report = auditModule.auditInventoryData({
    commands: [definition],
    features: [],
    handlerSource: 'case "layer.fixture_test":',
    commandFixtures: { [definition.id]: tampered },
    trustedPublicKey: signingKeys.publicKey
  });
  assert.equal(report.commands[0].fixture.valid, false);
  assert.ok(report.commands[0].fixture.problems.includes("evidence signature is invalid or trust key is missing"));
});

test("a signed provenance transaction cannot be reused for another command", () => {
  const first = command("supported");
  const second = { ...command("supported"), id: "layer.fixture_second" };
  const transactionId = "22222222-2222-4222-8222-222222222222";
  const report = auditModule.auditInventoryData({
    commands: [first, second],
    features: [],
    handlerSource: 'case "layer.fixture_test": case "layer.fixture_second":',
    commandFixtures: { [first.id]: fixture(first, transactionId), [second.id]: fixture(second, transactionId) },
    trustedPublicKey: signingKeys.publicKey
  });
  assert.equal(report.ok, false);
  assert.ok(report.commands.every((row: any) => row.fixture.problems.includes("provenance transaction was reused")));
});
