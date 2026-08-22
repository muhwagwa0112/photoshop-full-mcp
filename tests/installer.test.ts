import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const scriptsDir = resolve("scripts/install");

function powershell(script: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    cwd: resolve("."),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `PowerShell failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function powershellResult(script: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    cwd: resolve("."), env, encoding: "utf8",
  });
}

async function makeRelease(root: string, version: string, includeCcx = true): Promise<void> {
  const runtime = join(root, "payload", "runtime");
  const plugin = join(root, "payload", "uxp-plugin");
  await mkdir(join(runtime, "dist", "src"), { recursive: true });
  await mkdir(join(runtime, "node_modules", ".runtime-marker"), { recursive: true });
  await mkdir(plugin, { recursive: true });
  await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "photoshop-full-mcp", version, type: "module" }));
  await writeFile(join(runtime, "package-lock.json"), JSON.stringify({ name: "photoshop-full-mcp", version, lockfileVersion: 3 }));
  await writeFile(join(runtime, "dist", "src", "index.js"), `// ${version}\n`);
  await writeFile(join(plugin, "manifest.json"), JSON.stringify({ manifestVersion: 5, version }));
  if (includeCcx) await writeFile(join(root, `photoshop-full-mcp-v${version}.ccx`), `ccx-${version}`);
  for (const name of ["Install.ps1", "Doctor.ps1", "Update.ps1", "Uninstall.ps1", "Common.ps1"]) {
    await copyFile(join(scriptsDir, name), join(root, name));
  }
}

test("release install, local update, and uninstall preserve user data by default", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ps-mcp-installer-"));
  const installRoot = join(sandbox, "installed");
  const first = join(sandbox, "release-2.0.0");
  const second = join(sandbox, "release-2.0.1");
  const secondArchive = join(sandbox, "photoshop-full-mcp-v2.0.1-windows.zip");
  await makeRelease(first, "2.0.0");
  await makeRelease(second, "2.0.1");
  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, "bridge-secret.json"), "preserve-me");

  const installOutput = powershell(join(first, "Install.ps1"), ["-InstallRoot", installRoot, "-PackagePath", first, "-SkipCodexRegistration"]);
  assert.match(installOutput, /2\.0\.0 installed/);
  let current = JSON.parse(await readFile(join(installRoot, "app", "current.json"), "utf8")) as { version: string; entryPoint: string; ccxPath: string };
  assert.equal(current.version, "2.0.0");
  assert.match(current.entryPoint, /versions[\\/]2\.0\.0[\\/]runtime/);
  assert.equal(await readFile(current.ccxPath, "utf8"), "ccx-2.0.0");
  assert.match(installOutput, /Doctor: powershell .*Doctor\.ps1/);
  assert.match(installOutput, /Update: powershell .*Update\.ps1/);
  assert.match(installOutput, /Uninstall: powershell .*Uninstall\.ps1/);
  const doctorResult = powershellResult(join(installRoot, "app", "tools", "Doctor.ps1"), ["-InstallRoot", installRoot, "-Json"]);
  const doctor = JSON.parse(doctorResult.stdout) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
  const uxpInstall = doctor.checks.find((check) => check.name === "uxp-install-path");
  assert.equal(uxpInstall?.ok, true);
  assert.match(uxpInstall?.detail ?? "", /packaged UXP plugin/);

  const archiveSource = `${second.replaceAll("'", "''")}\\*`;
  const archiveTarget = secondArchive.replaceAll("'", "''");
  const archive = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${archiveSource}' -DestinationPath '${archiveTarget}' -Force`], { encoding: "utf8" });
  assert.equal(archive.status, 0, archive.stderr);
  await rm(first, { recursive: true, force: true });
  const installedUpdate = join(installRoot, "app", "tools", "Update.ps1");
  powershell(installedUpdate, ["-InstallRoot", installRoot, "-PackagePath", secondArchive, "-SkipCodexRegistration"]);
  current = JSON.parse(await readFile(join(installRoot, "app", "current.json"), "utf8")) as { version: string };
  assert.equal(current.version, "2.0.1");

  const installedUninstall = join(installRoot, "app", "tools", "Uninstall.ps1");
  powershell(installedUninstall, ["-InstallRoot", installRoot, "-SkipCodexRegistration"]);
  assert.equal(await readFile(join(installRoot, "bridge-secret.json"), "utf8"), "preserve-me");
  powershell(join(second, "Uninstall.ps1"), ["-InstallRoot", installRoot, "-SkipCodexRegistration", "-RemoveUserData"]);
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", `if (Test-Path -LiteralPath '${installRoot.replaceAll("'", "''")}') { exit 1 }`]);
  assert.equal(probe.status, 0);
});

test("source install runs the build exactly once", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ps-mcp-source-installer-"));
  const source = join(sandbox, "source");
  const installRoot = join(sandbox, "installed");
  const fakeBin = join(sandbox, "bin");
  const npmLog = join(sandbox, "npm.log");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "apps", "uxp-plugin"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "photoshop-full-mcp", version: "9.9.9", type: "module" }));
  await writeFile(join(source, "package-lock.json"), JSON.stringify({ name: "photoshop-full-mcp", version: "9.9.9", lockfileVersion: 3 }));
  await writeFile(join(source, "apps", "uxp-plugin", "manifest.json"), JSON.stringify({ manifestVersion: 5, version: "9.9.9" }));
  await writeFile(join(fakeBin, "npm.cmd"), [
    "@echo off",
    "echo %*>>\"%PS_MCP_NPM_LOG%\"",
    "if \"%3\"==\"run\" (",
    "  mkdir \"%~2\\dist\\src\" 2>nul",
    "  echo // built>\"%~2\\dist\\src\\index.js\"",
    ")",
    "if \"%3\"==\"ci\" mkdir \"%~2\\node_modules\" 2>nul",
    "exit /b 0",
  ].join("\r\n"));

  powershell(join(scriptsDir, "Install.ps1"), ["-InstallRoot", installRoot, "-PackagePath", source, "-SkipCodexRegistration"], {
    ...process.env,
    PATH: `${fakeBin};${process.env.PATH ?? ""}`,
    PS_MCP_NPM_LOG: npmLog,
  });
  const calls = await readFile(npmLog, "utf8");
  assert.equal((calls.match(/ run build/g) ?? []).length, 1);
  assert.equal((calls.match(/ ci /g) ?? []).length, 1);
  const doctorResult = powershellResult(join(installRoot, "app", "tools", "Doctor.ps1"), ["-InstallRoot", installRoot, "-Json"], {
    ...process.env,
    PATH: `${fakeBin};${process.env.PATH ?? ""}`,
  });
  const doctor = JSON.parse(doctorResult.stdout) as { checks: Array<{ name: string; detail: string }> };
  assert.match(doctor.checks.find((check) => check.name === "uxp-install-path")?.detail ?? "", /Manifest fallback/);
});

test("a failed Codex registration restores config and the previous installed version", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ps-mcp-registration-rollback-"));
  const installRoot = join(sandbox, "installed");
  const first = join(sandbox, "release-3.0.0");
  const second = join(sandbox, "release-3.0.1");
  const fakeBin = join(sandbox, "bin");
  const codexHome = join(sandbox, "codex-home");
  await makeRelease(first, "3.0.0");
  await makeRelease(second, "3.0.1");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), "original-config\n");
  await writeFile(join(fakeBin, "codex.cmd"), [
    "@echo off",
    "if \"%2\"==\"list\" (",
    "  echo photoshop_full_mcp existing",
    "  exit /b 0",
    ")",
    "if \"%2\"==\"remove\" (",
    "  echo removed>\"%CODEX_HOME%\\config.toml\"",
    "  exit /b 0",
    ")",
    "if \"%2\"==\"add\" (",
    "  echo corrupt>\"%CODEX_HOME%\\config.toml\"",
    "  exit /b 9",
    ")",
    "exit /b 1",
  ].join("\r\n"));

  powershell(join(first, "Install.ps1"), ["-InstallRoot", installRoot, "-PackagePath", first, "-SkipCodexRegistration"]);
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(second, "Install.ps1"),
    "-InstallRoot", installRoot, "-PackagePath", second,
  ], {
    cwd: resolve("."),
    env: { ...process.env, PATH: `${fakeBin};${process.env.PATH ?? ""}`, CODEX_HOME: codexHome },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), "original-config\n");
  const current = JSON.parse(await readFile(join(installRoot, "app", "current.json"), "utf8")) as { version: string };
  assert.equal(current.version, "3.0.0");
});
