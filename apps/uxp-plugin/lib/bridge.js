"use strict";

const { getToken, setToken, getServer, setServer, getPluginInstanceId } = require("./storage");
const { normalizeError, PluginError } = require("./errors");
const operations = require("./operations");

const FIRST_PORT = 38452;
const LAST_PORT = 38462;
const PROTOCOL = "ps-mcp-bridge/4";
const POLL_TIMEOUT_MS = 25_000;
const SUPPORTED_KINDS = new Set(["host.describe", "state.get", "preview.get", "command.execute", "advanced.batchplay", "approval.request", "job.resume", "job.cancel", "target.capture", "target.inspect", "automation.capabilities", "automation.execute", "operation.cancel", "operation.receipt", "operation.verify"]);

// UXP 9.3 discards IP-literal manifest origins. The Node bridge still binds
// exclusively to 127.0.0.1; localhost is only the permission-compatible client name.
function baseUrl(port) { return `http://localhost:${port}`; }

async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { throw new Error(`Bridge returned invalid JSON (${response.status})`); }
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomChallenge() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function discoveryProof(token, protocol, serverId, port, secretGeneration, challenge, ownerGeneration, executionProtocol) {
  if (!crypto.subtle || typeof crypto.subtle.importKey !== "function") {
    throw new Error("This UXP runtime cannot authenticate the local bridge; update Photoshop before reconnecting");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const fields = [protocol, serverId, String(port), String(secretGeneration), challenge];
  if (protocol === PROTOCOL) fields.push(ownerGeneration, executionProtocol);
  const payload = fields.join("\n");
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

async function probe(port, token) {
  const challenge = token ? randomChallenge() : null;
  const suffix = challenge ? `?challenge=${encodeURIComponent(challenge)}` : "";
  const response = await fetchWithTimeout(`${baseUrl(port)}/v1/discovery${suffix}`, { method: "GET" });
  if (!response.ok) return null;
  const data = await readJson(response);
  if (!data || ![PROTOCOL, "ps-mcp-bridge/3"].includes(data.protocol) || data.port !== port || !data.serverId) return null;
  if (token) {
    if (!Number.isInteger(data.secretGeneration) || typeof data.proof !== "string") return null;
    const expected = await discoveryProof(token, data.protocol, data.serverId, data.port, data.secretGeneration, challenge, data.ownerGeneration, data.executionProtocol);
    if (expected.length !== data.proof.length || expected !== data.proof) return null;
  }
  return { ...data, legacy: data.protocol !== PROTOCOL || data.executionProtocol !== operations.EXECUTION_PROTOCOL || !/^[A-Za-z0-9_.:-]{8,200}$/.test(data.ownerGeneration || "") };
}

async function discover() {
  const { servers, failures } = await discoverAllDetailed();
  if (!servers.length && failures.length) {
    const reason = failures[0].error && failures[0].error.message
      ? failures[0].error.message
      : String(failures[0].error || "unknown network error");
    throw new PluginError("HOST_ERROR", `No local bridge was discovered (${reason})`);
  }
  return servers.length ? servers[0] : null;
}

async function discoverAll(existingToken) {
  const { servers } = await discoverAllDetailed(existingToken);
  if (servers.some(server => server.legacy)) throw new PluginError("CAPABILITY_UNAVAILABLE", "An authenticated legacy bridge is still running. Stop the obsolete standalone bridge and update the runtime before native editing can resume.");
  return servers;
}

async function discoverAllDetailed(existingToken) {
  const token = existingToken === undefined ? await getToken() : existingToken;
  const remembered = getServer();
  const ports = [];
  if (remembered && remembered.port >= FIRST_PORT && remembered.port <= LAST_PORT) ports.push(remembered.port);
  for (let port = FIRST_PORT; port <= LAST_PORT; port += 1) if (!ports.includes(port)) ports.push(port);

  const probed = await Promise.all(ports.map(async (port) => {
    try { return { port, server: await probe(port, token), error: null }; }
    catch (error) { return { port, server: null, error }; }
  }));
  const servers = probed.map((item) => item.server).filter((server) => server && (
    !token || !remembered || !remembered.serverId || server.serverId === remembered.serverId
  ));
  return {
    servers,
    failures: probed.filter((item) => item.error).map(({ port, error }) => ({ port, error }))
  };
}

async function pair(codeValue) {
  const match = typeof codeValue === "string" ? /^(3845[2-9]|3846[0-2])-([A-Za-z0-9_-]{16,128})$/.exec(codeValue.trim()) : null;
  if (!match) throw new PluginError("PRECONDITION_FAILED", "Enter the complete port-code value shown by the trusted pairing dialog");
  const port = Number(match[1]);
  const code = match[2];
  const server = await probe(port, null);
  if (!server) throw new PluginError("HOST_ERROR", "The selected bridge is unavailable");
  if (server.legacy) throw new PluginError("CAPABILITY_UNAVAILABLE", "The selected bridge uses an obsolete execution protocol; update and stop it before pairing");
  const response = await fetchWithTimeout(`${baseUrl(server.port)}/v1/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, pluginInstanceId: getPluginInstanceId() })
  }, 5000);
  const data = await readJson(response);
  if (!response.ok || !data || !data.token || !data.serverId) throw new PluginError("HOST_ERROR", (data && data.error && data.error.message) || "Pairing was rejected");
  if (data.serverId !== server.serverId) throw new PluginError("HOST_ERROR", "Pair response serverId did not match discovery");
  await setToken(data.token);
  setServer({ serverId: data.serverId, port: server.port, protocol: PROTOCOL });
  return { serverId: data.serverId, port: server.port };
}

class BridgeClient {
  constructor(dispatch, onStatus) {
    this.dispatch = dispatch;
    this.onStatus = onStatus || (() => {});
    this.running = false;
    this.server = null;
    this.servers = [];
    this.seen = new Map();
    this.requestNonces = new Map();
    this.nonceRequests = new Map();
    this.executionTail = Promise.resolve();
    this.workers = new Map();
    this.generation = 0;
    this.deliveries = new Map();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((error) => this.onStatus("offline", error.message));
  }

  stop() {
    this.running = false;
    this.generation += 1;
    this.servers = [];
    this.server = null;
    this.workers.clear();
  }

  async reconnect() {
    this.generation += 1;
    this.server = null;
    this.servers = [];
    this.workers.clear();
    if (!this.running) await this.start();
  }

  async loop() {
    while (this.running) {
      try {
        const token = await getToken();
        if (!token) {
          this.servers = [];
          this.server = await discover();
          this.onStatus("offline", this.server ? `브리지 발견: ${this.server.port} (페어링 필요)` : "로컬 브리지를 찾을 수 없습니다.");
          await this.delay(1500);
          continue;
        }
        if (!this.server || !this.workers.size) {
          const discovered = await discoverAll(token);
          if (discovered.length > 1) throw new Error("More than one authenticated runtime owner is listening; stop obsolete bridge processes");
          this.servers = discovered;
          this.server = this.servers[0] || null;
        }
        if (!this.server) throw new Error("Paired bridge is not available");
        setServer({ serverId: this.server.serverId, port: this.server.port, protocol: PROTOCOL });
        const ports = this.servers.map((server) => server.port).join(", ");
        this.onStatus("online", `${this.server.serverId} · ${this.servers.length}개 브리지 (${ports})`);
        this.syncWorkers(token);
        await this.retryDeliveries(token);
        await this.delay(1000);
      } catch (error) {
        this.onStatus("connecting", error.message || String(error));
        this.server = null;
        this.servers = [];
        await this.delay(1000);
      }
    }
  }

  syncWorkers(token) {
    for (const server of this.servers) {
      for (const control of [false, true]) {
        const key = `${server.port}:${control ? "control" : "commands"}`;
        if (this.workers.has(key)) continue;
        const generation = this.generation;
        const worker = {};
        worker.promise = this.pollWorker(server, token, generation, control).finally(() => {
          if (this.workers.get(key) === worker) this.workers.delete(key);
        });
        this.workers.set(key, worker);
      }
    }
  }

  async pollWorker(server, token, generation, control) {
    while (this.running && generation === this.generation && this.servers.some((item) => item.port === server.port)) {
      try { await this.pollOnce(server, token, generation, control); }
      catch (error) {
        this.onStatus("connecting", `localhost:${server.port} · ${error.message || String(error)}`);
        return;
      }
    }
  }

  async pollOnce(server, token, generation = this.generation, control = false) {
    const headers = { Authorization: `Bearer ${token}`, "X-Plugin-Instance": getPluginInstanceId(), "X-Host-Epoch": operations.hostEpoch };
    const response = await fetchWithTimeout(`${baseUrl(server.port)}/v1/${control ? "control" : "poll"}`, { method: "GET", headers }, POLL_TIMEOUT_MS);
    if (!this.running || generation !== this.generation) return;
    if (response.status === 204) { await this.delay(150); return; }
    if (response.status === 401 || response.status === 403) throw new Error("Bridge authentication was rejected; reconnect the paired owner");
    if (!response.ok) throw new Error(`Poll failed (${response.status})`);
    const request = await readJson(response);
    this.validateRequest(request, server);
    if (control) {
      let data;
      if (request.kind === "operation.cancel") data = operations.requestCancel(request.payload.operationId);
      else if (request.kind === "operation.receipt") data = operations.operationReceipt(request.payload.operationId, request.payload.requestDigest);
      else throw new PluginError("PRECONDITION_FAILED", "Control channel cannot execute native mutations");
      await this.postResult(server, token, request, { ok: true, data, effect: "not_applied", hostEpoch: operations.hostEpoch, operationId: request.operationId });
      return;
    }
    // The receive loop stays available while a native operation is awaiting an
    // Adobe call. Ordering comes from the Node owner; this tail only serializes
    // that order inside one UXP executor.
    const task = this.enqueueDispatch(request, server, token);
    task.then((result) => {
      const key = request.operationId || request.requestId;
      this.deliveries.set(key, { server, request, result });
      return this.deliverReceipt(key, token);
    }).catch((error) => {
      this.onStatus("connecting", error.message || String(error));
    });
  }

  enqueueDispatch(request, server, token) {
    const execute = () => { this.validateRequest(request, server); return operations.executeOperation(request, (operationContext) => this.dispatch(request.kind, request.payload || {}, {
      ...operationContext,
      get cancelRequested() { return operationContext.cancelRequested; },
      serverPort: server.port, serverId: server.serverId,
      uploadExport: (binary, metadata) => this.uploadExport(server, token, request, binary, metadata),
      downloadImport: (fileName, assetKey) => this.downloadImport(server, token, request, fileName, assetKey)
    })); };
    const task = this.executionTail.then(execute, execute).catch((error) => ({
      requestId: request.requestId, nonce: request.nonce, operationId: request.operationId,
      hostEpoch: operations.hostEpoch, ok: false, effect: error.details && error.details.effect || "not_applied", error: normalizeError(error)
    }));
    this.executionTail = task.then(() => undefined);
    return task;
  }

  async deliverReceipt(key, token) {
    const delivery = this.deliveries.get(key);
    if (!delivery) return;
    try {
      await this.postResult(delivery.server, token, delivery.request, delivery.result);
      operations.acknowledge(key);
      this.deliveries.delete(key);
    } catch (error) {
      this.onStatus("connecting", `Receipt retained for retry: ${error.message || error}`);
    }
  }

  async retryDeliveries(token) {
    for (const key of this.deliveries.keys()) await this.deliverReceipt(key, token);
  }

  async uploadExport(server, token, request, binary, metadata = {}) {
    if (!token || !request || typeof request.requestId !== "string" || typeof request.nonce !== "string") {
      throw new PluginError("HOST_ERROR", "Export upload is not bound to an authenticated bridge request");
    }
    const name = String(metadata.name || "");
    const format = String(metadata.format || "");
    const url = `${baseUrl(server.port)}/v1/export?name=${encodeURIComponent(name)}&format=${encodeURIComponent(format)}`;
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Plugin-Instance": getPluginInstanceId(),
        "X-Request-Id": request.requestId,
        "X-Request-Nonce": request.nonce,
        "X-On-Conflict": metadata.onConflict || "error",
        "Content-Type": "application/octet-stream"
      },
      body: binary
    }, 180000);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      const error = data && data.error;
      throw new PluginError(error && error.code || "HOST_ERROR", error && error.message || `Default export upload failed (${response.status})`);
    }
    return data.result || {};
  }

  async downloadImport(server, token, request, fileName, assetKey) {
    if (!token || !request || typeof request.requestId !== "string" || typeof request.nonce !== "string") {
      throw new PluginError("HOST_ERROR", "Import download is not bound to an authenticated bridge request");
    }
    const name = String(fileName || "");
    if (!name || name.length > 255 || /[\\/:*?"<>|\x00-\x1f]/.test(name)) {
      throw new PluginError("PRECONDITION_FAILED", "Invalid default import file name");
    }
    const query = `request_id=${encodeURIComponent(request.requestId)}&nonce=${encodeURIComponent(request.nonce)}&file_name=${encodeURIComponent(name)}${assetKey ? `&asset_key=${encodeURIComponent(assetKey)}` : ""}`;
    const response = await fetchWithTimeout(`${baseUrl(server.port)}/v1/import?${query}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Plugin-Instance": getPluginInstanceId()
      }
    }, 180000);
    if (!response.ok) {
      const data = await readJson(response).catch(() => null);
      const error = data && data.error;
      throw new PluginError(error && error.code || "HOST_ERROR", error && error.message || `Default import download failed (${response.status})`);
    }
    const binary = await response.arrayBuffer();
    if (!(binary instanceof ArrayBuffer) || binary.byteLength === 0) throw new PluginError("HOST_ERROR", "Default import download returned no bytes");
    return binary;
  }

  validateRequest(request, server) {
    if (!request || typeof request.requestId !== "string" || typeof request.nonce !== "string" || !(typeof request.deadline === "string" || typeof request.deadline === "number") || typeof request.kind !== "string") {
      throw new Error("Bridge request is missing requestId, nonce, deadline, or kind");
    }
    if (!Number.isFinite(this.deadlineMs(request.deadline))) throw new Error("Bridge request deadline is invalid");
    if (!SUPPORTED_KINDS.has(request.kind)) throw new Error(`Bridge request kind is not allowlisted: ${request.kind}`);
    if (!server || server.protocol !== PROTOCOL || server.legacy) throw new PluginError("CAPABILITY_UNAVAILABLE", "Native requests require the authenticated current runtime owner; legacy bridge execution is disabled");
    operations.validateExecutionRequest(request, server);
  }

  deadlineMs(value) {
    return typeof value === "number" ? value : Date.parse(value);
  }

  remember(key, result) {
    this.seen.set(key, result);
    while (this.seen.size > 128) {
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }
    while (this.requestNonces.size > 256) {
      const requestIdentity = this.requestNonces.keys().next().value;
      const nonce = this.requestNonces.get(requestIdentity);
      const separator = requestIdentity.indexOf("|");
      const scopedNonce = `${requestIdentity.slice(0, separator)}|${nonce}`;
      const requestId = requestIdentity.slice(separator + 1);
      this.requestNonces.delete(requestIdentity);
      if (this.nonceRequests.get(scopedNonce) === requestId) this.nonceRequests.delete(scopedNonce);
    }
  }

  async postResult(server, token, request, result) {
    const response = await fetchWithTimeout(`${baseUrl(server.port)}/v1/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Plugin-Instance": getPluginInstanceId(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ requestId: request.requestId, nonce: request.nonce, operationId: request.operationId, hostEpoch: operations.hostEpoch, ...result })
    }, 5000);
    if (!response.ok) throw new Error(`Result delivery failed (${response.status})`);
  }

  async postJobDecision(jobId, decision, body, issuingPort) {
    const target = this.servers.find((server) => server.port === issuingPort) || (this.server && (!issuingPort || this.server.port === issuingPort) ? this.server : null);
    if (!target) throw new Error(`Issuing bridge is not connected${issuingPort ? ` on port ${issuingPort}` : ""}`);
    if (decision !== "resume" && decision !== "cancel") throw new Error("Invalid job decision");
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(jobId)) throw new Error("Invalid job id");
    const token = await getToken();
    if (!token) throw new Error("Bridge is not paired");
    const response = await fetchWithTimeout(`${baseUrl(target.port)}/v1/jobs/${encodeURIComponent(jobId)}/${decision}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Plugin-Instance": getPluginInstanceId(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    }, 5000);
    const data = await readJson(response);
    if (!response.ok) throw new Error((data && data.error && data.error.message) || `Job ${decision} failed (${response.status})`);
    return data;
  }

  async unpairAll() {
    const token = await getToken();
    if (!token) return { rotated: 0 };
    const servers = await discoverAll(token);
    if (!servers.length) throw new Error("No authenticated bridge is available to rotate the pairing token");
    const outcomes = await Promise.allSettled(servers.map(async (server) => {
      const response = await fetchWithTimeout(`${baseUrl(server.port)}/v1/unpair`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Plugin-Instance": getPluginInstanceId(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ pluginInstanceId: getPluginInstanceId() })
      }, 5000);
      if (!response.ok) throw new Error(`Token rotation failed on port ${server.port} (${response.status})`);
      return server.port;
    }));
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failures.length) throw new Error(failures.map((outcome) => outcome.reason.message || String(outcome.reason)).join("; "));
    return { rotated: outcomes.length, ports: outcomes.map((outcome) => outcome.value) };
  }

  resumeJob(jobId, issuingPort, result = { approved: true }) {
    return this.postJobDecision(jobId, "resume", { ok: true, result }, issuingPort);
  }

  cancelJob(jobId, issuingPort, result = { approved: false }) {
    return this.postJobDecision(jobId, "cancel", { ok: false, result }, issuingPort);
  }

  delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
}

module.exports = { BridgeClient, discover, discoverAll, pair, probe, discoveryProof, FIRST_PORT, LAST_PORT, PROTOCOL };
