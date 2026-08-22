"use strict";

const { entrypoints } = require("uxp");
const { BridgeClient, discover, pair } = require("./lib/bridge");
const { dispatch, onApprovalRequest, markApprovalJob } = require("./lib/commands");
const { clearToken, clearServer, chooseExportFolder, getExportFolder } = require("./lib/storage");

let client;
let lastServer;
let pendingApproval;

function byId(id) { return document.getElementById(id); }

function status(kind, detail) {
  const badge = byId("connectionBadge");
  if (!badge) return;
  badge.className = `badge ${kind}`;
  badge.textContent = kind === "online" ? "연결됨" : kind === "connecting" ? "연결 중" : "오프라인";
  byId("connectionDetail").textContent = detail || "";
}

function activity(message) {
  const now = new Date().toLocaleTimeString();
  const node = byId("activity");
  if (node) node.textContent = `[${now}] ${message}`;
}

async function refreshExportFolder() {
  const folder = await getExportFolder();
  byId("exportFolderDetail").textContent = folder ? `선택됨: ${folder.name}` : "내보내기 폴더가 선택되지 않았습니다.";
}

async function initialize() {
  byId("pairButton").addEventListener("click", async () => {
    try {
      status("connecting", "페어링 중…");
      lastServer = lastServer || await discover();
      const result = await pair(lastServer, byId("pairCode").value || "");
      byId("pairCode").value = "";
      activity(`페어링 완료: ${result.serverId}`);
      await client.reconnect();
    } catch (error) {
      status("offline", error.message);
      activity(`페어링 실패: ${error.message}`);
    }
  });

  byId("reconnectButton").addEventListener("click", async () => {
    lastServer = await discover();
    activity(lastServer ? `브리지 발견: ${lastServer.port}` : "브리지를 찾지 못했습니다.");
    await client.reconnect();
  });

  byId("unpairButton").addEventListener("click", async () => {
    try {
      activity("인증된 브리지의 페어링 토큰을 회전하는 중…");
      const result = await client.unpairAll();
      await clearToken();
      clearServer();
      lastServer = null;
      await client.reconnect();
      status("offline", "연결이 해제되었습니다.");
      activity(`서버 ${result.rotated}개에서 토큰을 회전하고 로컬 페어링 토큰을 삭제했습니다.`);
    } catch (error) {
      activity(`연결 해제 실패; 로컬 토큰을 유지했습니다: ${error.message}`);
    }
  });

  byId("chooseExportFolderButton").addEventListener("click", async () => {
    try {
      const folder = await chooseExportFolder();
      activity(`내보내기 폴더 선택: ${folder.name}`);
      await refreshExportFolder();
    } catch (error) {
      activity(`폴더 선택 취소 또는 실패: ${error.message}`);
    }
  });

  byId("approveJobButton").addEventListener("click", async () => {
    if (!pendingApproval) return;
    const job = pendingApproval;
    try {
      const result = job.kind === "user_assisted" ? { completed: true } : { approved: true };
      await client.resumeJob(job.jobId, job.serverPort, result);
      markApprovalJob(job.jobId, "completed");
      activity(`승인 완료: ${job.label}`);
      pendingApproval = null;
      renderPendingApproval();
    } catch (error) { activity(`승인 전달 실패: ${error.message}`); }
  });

  byId("rejectJobButton").addEventListener("click", async () => {
    if (!pendingApproval) return;
    const job = pendingApproval;
    try {
      const result = job.kind === "user_assisted" ? { completed: false } : { approved: false };
      await client.cancelJob(job.jobId, job.serverPort, result);
      markApprovalJob(job.jobId, "cancelled");
      activity(`승인 거부: ${job.label}`);
      pendingApproval = null;
      renderPendingApproval();
    } catch (error) { activity(`거부 전달 실패: ${error.message}`); }
  });

  onApprovalRequest((job) => {
    pendingApproval = job;
    renderPendingApproval();
    activity(`사용자 승인 대기: ${job.label}`);
  });

  await refreshExportFolder();
  try {
    lastServer = await discover();
  } catch (error) {
    lastServer = null;
    status("offline", error.message || String(error));
  }
  client = new BridgeClient(async (kind, payload, context) => {
    activity(`실행: ${kind}`);
    const result = await dispatch(kind, payload, context);
    activity(`완료: ${kind}`);
    return result;
  }, status);
  await client.start();
}

function renderPendingApproval() {
  const card = byId("pendingApprovalCard");
  if (!pendingApproval) {
    document.body.classList.remove("approval-mode");
    card.classList.add("hidden");
    return;
  }
  document.body.classList.add("approval-mode");
  byId("pendingApprovalLabel").textContent = pendingApproval.label;
  byId("pendingApprovalTitle").textContent = pendingApproval.kind === "user_assisted" ? "수동 작업 대기" : "승인 대기";
  byId("pendingApprovalRisk").textContent = pendingApproval.kind === "user_assisted"
    ? `수동 작업: ${pendingApproval.commandId}`
    : `명령: ${pendingApproval.commandId} · 위험: ${pendingApproval.risk}`;
  byId("pendingApprovalInstruction").textContent = pendingApproval.instruction || "";
  const consequence = byId("pendingApprovalConsequence");
  const digest = byId("pendingApprovalDigest");
  if (pendingApproval.kind === "approval") {
    consequence.textContent = `실행 결과: ${pendingApproval.consequence}`;
    digest.textContent = `범위 digest: ${pendingApproval.scopeDigest}`;
    consequence.classList.remove("hidden");
    digest.classList.remove("hidden");
  } else {
    consequence.textContent = "";
    digest.textContent = "";
    consequence.classList.add("hidden");
    digest.classList.add("hidden");
  }
  byId("approveJobButton").textContent = pendingApproval.kind === "user_assisted" ? "완료" : "승인";
  byId("rejectJobButton").textContent = pendingApproval.kind === "user_assisted" ? "취소" : "거부";
  card.classList.remove("hidden");
}

entrypoints.setup({
  panels: {
    photoshopFullMcpPanel: {
      show() {
        if (!client) initialize().catch((error) => status("offline", error.message));
      },
      hide() {},
      destroy() { if (client) client.stop(); }
    }
  }
});
