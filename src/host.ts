import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface InstalledPhotoshop {
  registryVersion: string;
  productVersion?: string;
  applicationPath?: string;
  executablePath?: string;
  reachable: boolean;
}

async function readProductVersion(executablePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "$p=$env:PS_MCP_EXE;(Get-Item -LiteralPath $p).VersionInfo.ProductVersion"],
      { windowsHide: true, timeout: 5_000, encoding: "utf8", env: { ...process.env, PS_MCP_EXE: executablePath } },
    );
    const version = stdout.trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

export async function discoverInstalledPhotoshop(): Promise<InstalledPhotoshop[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", "HKLM\\SOFTWARE\\Adobe\\Photoshop", "/s"], {
      windowsHide: true,
      timeout: 5_000,
      encoding: "utf8",
    });
    const results: InstalledPhotoshop[] = [];
    let currentVersion: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const key = /\\Photoshop\\([^\\\s]+)\s*$/.exec(line.trim());
      if (key) {
        currentVersion = key[1];
        continue;
      }
      const match = /^\s*ApplicationPath\s+REG_\w+\s+(.+)$/i.exec(line);
      if (!match || !currentVersion) continue;
      const applicationPath = match[1]?.trim();
      const executablePath = applicationPath ? `${applicationPath.replace(/[\\/]$/, "")}\\Photoshop.exe` : undefined;
      let reachable = false;
      if (executablePath) {
        try {
          await access(executablePath);
          reachable = true;
        } catch {
          reachable = false;
        }
      }
      const productVersion = reachable && executablePath ? await readProductVersion(executablePath) : undefined;
      results.push({
        registryVersion: currentVersion,
        ...(productVersion ? { productVersion } : {}),
        ...(applicationPath ? { applicationPath } : {}),
        ...(executablePath ? { executablePath } : {}),
        reachable,
      });
    }
    return results;
  } catch {
    return [];
  }
}
