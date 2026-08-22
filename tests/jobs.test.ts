import assert from "node:assert/strict";
import { test } from "node:test";
import { PhotoshopMcpError } from "../src/errors.js";
import { JobStore } from "../src/jobs.js";

test("job lifecycle supports awaiting user, completion, and idempotent cancellation", () => {
  const jobs = new JobStore();
  const created = jobs.create("ui.camera_raw_filter");
  assert.equal(created.status, "queued");
  const waiting = jobs.update(created.id, { status: "awaiting_user" });
  assert.equal(waiting.status, "awaiting_user");
  const completed = jobs.update(created.id, { status: "completed", result: { approved: true } });
  assert.equal(completed.status, "completed");
  assert.equal(jobs.cancel(created.id).status, "completed");
});

test("unknown jobs fail closed", () => {
  const jobs = new JobStore();
  assert.throws(
    () => jobs.get("missing"),
    (error) => error instanceof PhotoshopMcpError && error.code === "PRECONDITION_FAILED",
  );
});

test("job kind cannot be changed through updates", () => {
  const jobs = new JobStore();
  const approval = jobs.create("approval:layer.delete", "awaiting_user", { kind: "approval" });
  assert.equal(approval.kind, "approval");
  assert.equal(jobs.update(approval.id, { message: "still approval" }).kind, "approval");
});

test("job store prunes terminal and abandoned records and rejects excess active work", () => {
  let now = Date.UTC(2026, 0, 1);
  const jobs = new JobStore({ maxEntries: 2, terminalTtlMs: 100, activeTtlMs: 200, now: () => now });
  const completed = jobs.create("completed", "completed");
  const active = jobs.create("active", "running");
  assert.throws(
    () => jobs.create("overflow"),
    (error) => error instanceof PhotoshopMcpError && error.code === "MODAL_BUSY",
  );
  now += 101;
  assert.throws(() => jobs.get(completed.id), /Unknown job/);
  const replacement = jobs.create("replacement");
  assert.equal(jobs.list().length, 2);
  now += 200;
  assert.throws(() => jobs.get(active.id), /Unknown job/);
  assert.throws(() => jobs.get(replacement.id), /Unknown job/);
  assert.equal(jobs.list().length, 0);
});
