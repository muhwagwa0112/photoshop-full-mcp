"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const errors = [];

if (manifest.manifestVersion !== 5) errors.push("manifestVersion must be 5");
if (!manifest.host || manifest.host.app !== "PS") errors.push("Photoshop host is missing");
if (!manifest.host || manifest.host.minVersion !== "24.0.0") errors.push("minVersion must be 24.0.0");
if (!manifest.host || !manifest.host.data || manifest.host.data.apiVersion !== 2) errors.push("Photoshop apiVersion must be 2");
const domains = manifest.requiredPermissions && manifest.requiredPermissions.network && manifest.requiredPermissions.network.domains;
const expectedLoopbackDomains = Array.from({ length: 11 }, (_, index) => `http://localhost:${38452 + index}`);
if (!Array.isArray(domains) || domains.length !== expectedLoopbackDomains.length || expectedLoopbackDomains.some((domain) => !domains.includes(domain))) {
  errors.push("the complete localhost bridge port range must be explicitly permitted");
}

const files = ["main.js", "lib/storage.js", "lib/errors.js", "lib/commands.js", "lib/bridge.js"];
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  try { new vm.Script(source, { filename: file }); } catch (error) { errors.push(`${file}: ${error.message}`); }
}

const bridge = fs.readFileSync(path.join(root, "lib/bridge.js"), "utf8");
for (let port = 38452; port <= 38462; port += 1) {
  if (!bridge.includes("FIRST_PORT = 38452") || !bridge.includes("LAST_PORT = 38462")) {
    errors.push(`bridge does not cover required port ${port}`);
    break;
  }
}

const storage = fs.readFileSync(path.join(root, "lib/storage.js"), "utf8");
if (/\bText(?:Encoder|Decoder)\b/.test(storage)) errors.push("storage must not depend on unavailable UXP TextEncoder/TextDecoder globals");
for (const contract of ["encodeToken", "decodeToken", "printable ASCII"]) {
  if (!storage.includes(contract)) errors.push(`UXP token codec contract missing: ${contract}`);
}
for (const route of ["/v1/discovery", "/v1/pair", "/v1/poll", "/v1/result", "/v1/export", "/v1/jobs/", "/v1/unpair"]) {
  if (!bridge.includes(route)) errors.push(`bridge route missing: ${route}`);
}
for (const contract of ["discoverAll", "syncWorkers", "pollWorker", "postResult(server", "uploadExport(server", "issuingPort", "serverPort: server.port"]) {
  if (!bridge.includes(contract)) errors.push(`multi-bridge contract missing: ${contract}`);
}

const commands = fs.readFileSync(path.join(root, "lib/commands.js"), "utf8");
for (const probe of ["runtimeProbes", "documentsAdd", "createDocument", "batchPlay", "executeAsModal", "getPixels", "encodeImageData", "gatedCapabilities", "GenerativeUpscaleModel", 'status: "not_publicly_probeable"']) {
  if (!commands.includes(probe)) errors.push(`host capability probe missing: ${probe}`);
}
for (const hostMetadataProbe of ["uxp.host.name", "uxp.host.version", "uxp.host.uiLocale", "uxp.versions.uxp", "uxp.versions.plugin"]) {
  if (!commands.includes(hostMetadataProbe)) errors.push(`host metadata probe missing: ${hostMetadataProbe}`);
}
for (const assisted of ["USER_ASSISTED_COMMANDS", '"document.save"', '"ui.camera_raw_filter"', "enqueueUserJob", '"user_assisted"', "awaitingUser: true", "serverPort: context.serverPort", "approval jobs can only be completed by an explicit panel decision", "payload.consequence", "payload.scopeDigest"]) {
  if (!commands.includes(assisted)) errors.push(`user-assisted contract missing: ${assisted}`);
}

const panel = fs.readFileSync(path.join(root, "main.js"), "utf8");
for (const display of ["pendingApprovalConsequence", "pendingApprovalDigest", "pendingApproval.consequence", "pendingApproval.scopeDigest", ".textContent"]) {
  if (!panel.includes(display)) errors.push(`approval display contract missing: ${display}`);
}
if (!panel.includes('document.body.classList.add("approval-mode")') || !panel.includes('document.body.classList.remove("approval-mode")')) {
  errors.push("approval mode must keep panel decisions visible in the minimum panel size");
}

const panelHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (panelHtml.includes("<sp-button")) errors.push("panel actions must use keyboard-accessible native button elements");
for (const id of ["pairButton", "reconnectButton", "unpairButton", "chooseExportFolderButton", "approveJobButton", "rejectJobButton"]) {
  if (!panelHtml.includes(`<button id="${id}"`)) errors.push(`accessible panel button missing: ${id}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`UXP static checks passed (${files.length} JavaScript files, Manifest v${manifest.manifestVersion}).`);
