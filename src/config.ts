import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ServerConfig {
  dataDir: string;
  exportDir: string;
  portStart: number;
  portEnd: number;
  commandTimeoutMs: number;
  approvalMode: "auto" | "panel";
  advancedProfile: "safe" | "confirm";
  validationProfile?: "disabled" | "confirm";
  allowedRoots: string[];
  serverId: string;
  bridgeToken: string;
  pairedPluginInstanceId?: string;
  secretGeneration?: number;
}

interface PersistedSecret {
  serverId: string;
  bridgeToken: string;
  pairedPluginInstanceId?: string;
  secretGeneration?: number;
}

function defaultDataDir(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), ".local", "share");
  return join(base, "PS_MCP");
}

async function secureOwnerOnly(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
    return;
  }
  if (!process.env.USERNAME) throw new Error("Cannot secure Photoshop MCP secret: Windows user identity is unavailable");
  const identity = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  const { stdout } = await execFileAsync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${identity}:(F)`], {
    windowsHide: true,
    timeout: 5_000,
  });
  if (!stdout.toLocaleLowerCase().includes(process.env.USERNAME.toLocaleLowerCase())) {
    throw new Error("Cannot verify owner-only ACL for Photoshop MCP secret");
  }
  const escapedPath = path.replace(/'/g, "''");
  const aclScript = [
    "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop",
    "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `$entries=@((Get-Acl -LiteralPath '${escapedPath}').Access | ForEach-Object {`,
    "  [pscustomobject]@{ sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; type=$_.AccessControlType.ToString(); inherited=$_.IsInherited }",
    "})",
    "[pscustomobject]@{ current=$current; entries=$entries } | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  const { stdout: aclJson } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclScript], {
    windowsHide: true,
    timeout: 5_000,
  });
  const acl = JSON.parse(aclJson) as { current: string; entries?: Array<{ sid: string; type: string; inherited: boolean }> | { sid: string; type: string; inherited: boolean } };
  const entries = Array.isArray(acl.entries) ? acl.entries : acl.entries ? [acl.entries] : [];
  const permitted = new Set([acl.current, "S-1-5-18", "S-1-5-32-544"]);
  if (entries.some((entry) => entry.type === "Allow" && (!permitted.has(entry.sid) || entry.inherited))) {
    throw new Error("Photoshop MCP secret ACL grants access outside the current user boundary");
  }
}

async function writeOwnerOnly(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await secureOwnerOnly(temporary);
    await rename(temporary, path);
    await secureOwnerOnly(path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function loadOrCreateSecret(dataDir: string): Promise<PersistedSecret> {
  const path = join(dataDir, "bridge-secret.json");
  if (existsSync(path)) {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedSecret>;
    if (typeof parsed.serverId === "string" && typeof parsed.bridgeToken === "string" && parsed.bridgeToken.length >= 32) {
      await secureOwnerOnly(path);
      return parsed as PersistedSecret;
    }
  }
  const secret = { serverId: randomUUID(), bridgeToken: randomBytes(32).toString("base64url") };
  await writeOwnerOnly(path, secret);
  return secret;
}

export async function loadConfig(overrides: Partial<ServerConfig> = {}): Promise<ServerConfig> {
  const dataDir = resolve(overrides.dataDir ?? process.env.PS_MCP_DATA_DIR ?? defaultDataDir());
  const secret = await loadOrCreateSecret(dataDir);
  const exportDir = resolve(overrides.exportDir ?? process.env.PS_MCP_EXPORT_DIR ?? join(dataDir, "exports"));
  await mkdir(exportDir, { recursive: true });
  const allowedRoots = overrides.allowedRoots ?? [exportDir, tmpdir()];
  return {
    dataDir,
    exportDir,
    portStart: overrides.portStart ?? Number(process.env.PS_MCP_PORT_START ?? 38452),
    portEnd: overrides.portEnd ?? Number(process.env.PS_MCP_PORT_END ?? 38462),
    commandTimeoutMs: overrides.commandTimeoutMs ?? Number(process.env.PS_MCP_COMMAND_TIMEOUT_MS ?? 30_000),
    approvalMode: overrides.approvalMode ?? (process.env.PS_MCP_APPROVAL_MODE === "panel" ? "panel" : "auto"),
    advancedProfile: overrides.advancedProfile ?? (process.env.PS_MCP_ADVANCED === "confirm" ? "confirm" : "safe"),
    validationProfile: overrides.validationProfile ?? (process.env.PS_MCP_VALIDATION === "confirm" ? "confirm" : "disabled"),
    allowedRoots: allowedRoots.map((entry) => resolve(entry)),
    serverId: overrides.serverId ?? secret.serverId,
    bridgeToken: overrides.bridgeToken ?? secret.bridgeToken,
    ...((overrides.pairedPluginInstanceId ?? secret.pairedPluginInstanceId) ? { pairedPluginInstanceId: overrides.pairedPluginInstanceId ?? secret.pairedPluginInstanceId } : {}),
    secretGeneration: overrides.secretGeneration ?? secret.secretGeneration ?? 0,
  };
}

export async function writeEndpointFile(config: ServerConfig, port: number): Promise<void> {
  await writeOwnerOnly(join(config.dataDir, "bridge-endpoint.json"), {
    protocol: "ps-mcp-bridge/2",
    serverId: config.serverId,
    host: "127.0.0.1",
    port,
    updatedAt: new Date().toISOString(),
  });
}

export async function rotateBridgeSecret(config: ServerConfig): Promise<string> {
  return withSecretLock(config.dataDir, async () => {
    const persisted = await readPersistedSecret(config.dataDir);
    const currentGeneration = config.secretGeneration ?? 0;
    if (persisted && ((persisted.secretGeneration ?? 0) > currentGeneration || persisted.bridgeToken !== config.bridgeToken)) {
      applyPersistedSecret(config, persisted);
      delete config.pairedPluginInstanceId;
      return config.bridgeToken;
    }
    const nextToken = randomBytes(32).toString("base64url");
    const nextGeneration = currentGeneration + 1;
    await writeOwnerOnly(join(config.dataDir, "bridge-secret.json"), {
      serverId: config.serverId,
      bridgeToken: nextToken,
      secretGeneration: nextGeneration,
    });
    config.bridgeToken = nextToken;
    config.secretGeneration = nextGeneration;
    delete config.pairedPluginInstanceId;
    return nextToken;
  });
}

export async function persistBridgePairing(config: ServerConfig, pluginInstanceId: string): Promise<void> {
  await withSecretLock(config.dataDir, async () => {
    const persisted = await readPersistedSecret(config.dataDir);
    if (persisted) applyPersistedSecret(config, persisted);
    await writeOwnerOnly(join(config.dataDir, "bridge-secret.json"), {
      serverId: config.serverId,
      bridgeToken: config.bridgeToken,
      pairedPluginInstanceId: pluginInstanceId,
      secretGeneration: config.secretGeneration ?? 0,
    });
    config.pairedPluginInstanceId = pluginInstanceId;
  });
}

async function readPersistedSecret(dataDir: string): Promise<PersistedSecret | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, "bridge-secret.json"), "utf8")) as Partial<PersistedSecret>;
    if (typeof parsed.serverId === "string" && typeof parsed.bridgeToken === "string" && parsed.bridgeToken.length >= 32) return parsed as PersistedSecret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
}

function applyPersistedSecret(config: ServerConfig, persisted: PersistedSecret): void {
  if (persisted.serverId !== config.serverId) throw new Error("Photoshop MCP server identity changed unexpectedly");
  config.bridgeToken = persisted.bridgeToken;
  config.secretGeneration = persisted.secretGeneration ?? 0;
  if (persisted.pairedPluginInstanceId) config.pairedPluginInstanceId = persisted.pairedPluginInstanceId;
  else delete config.pairedPluginInstanceId;
}

async function withSecretLock<T>(dataDir: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(dataDir, "bridge-secret.lock");
  await mkdir(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", encoding: "utf8" });
      try {
        return await action();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
  throw new Error("Timed out acquiring the Photoshop MCP secret lock");
}

export async function refreshBridgeSecret(config: ServerConfig): Promise<void> {
  const persisted = await readPersistedSecret(config.dataDir);
  if (persisted) applyPersistedSecret(config, persisted);
}
