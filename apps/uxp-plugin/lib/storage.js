"use strict";

const { storage } = require("uxp");
const secureStorage = storage.secureStorage;
const localFileSystem = storage.localFileSystem;
const binaryFormat = storage.formats.binary;

const TOKEN_KEY = "photoshop-full-mcp.bridge-token.v2";
const SERVER_KEY = "photoshop-full-mcp.server.v2";
const INSTANCE_KEY = "photoshop-full-mcp.instance.v2";
const EXPORT_FOLDER_KEY = "photoshop-full-mcp.export-folder.v2";

function encodeToken(value) {
  if (!/^[\x20-\x7e]+$/.test(value)) throw new Error("Bridge token must contain printable ASCII only");
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function decodeToken(bytes) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function randomId(prefix) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function getToken() {
  const bytes = await secureStorage.getItem(TOKEN_KEY);
  return bytes ? decodeToken(bytes) : null;
}

async function setToken(token) {
  if (!token || typeof token !== "string") throw new Error("Invalid bridge token");
  await secureStorage.setItem(TOKEN_KEY, encodeToken(token));
}

async function clearToken() {
  await secureStorage.removeItem(TOKEN_KEY);
}

function getServer() {
  try { return JSON.parse(localStorage.getItem(SERVER_KEY) || "null"); } catch (_) { return null; }
}

function setServer(server) {
  localStorage.setItem(SERVER_KEY, JSON.stringify(server));
}

function clearServer() {
  localStorage.removeItem(SERVER_KEY);
}

function getPluginInstanceId() {
  let id = localStorage.getItem(INSTANCE_KEY);
  if (!id) {
    id = randomId("uxp");
    localStorage.setItem(INSTANCE_KEY, id);
  }
  return id;
}

async function chooseExportFolder() {
  const folder = await localFileSystem.getFolder();
  if (!folder) return null;
  const token = await localFileSystem.createPersistentToken(folder);
  localStorage.setItem(EXPORT_FOLDER_KEY, token);
  return folder;
}

async function getExportFolder() {
  const token = localStorage.getItem(EXPORT_FOLDER_KEY);
  if (!token) return null;
  try { return await localFileSystem.getEntryForPersistentToken(token); } catch (_) { return null; }
}

async function resolvePersistentEntry(token) {
  if (!token) return null;
  return localFileSystem.getEntryForPersistentToken(token);
}

async function createTemporaryExportFile(name) {
  const folder = await localFileSystem.getTemporaryFolder();
  return folder.createFile(name, { overwrite: true });
}

async function readEntryBinary(entry) {
  if (!entry || typeof entry.read !== "function") throw new Error("A readable temporary export entry is required");
  return entry.read({ format: binaryFormat });
}

async function materializeTemporaryImportFile(name, binary) {
  const safeName = String(name || "");
  if (!safeName || safeName.length > 255 || /[\\/:*?"<>|\x00-\x1f]/.test(safeName)) throw new Error("Invalid temporary import file name");
  if (!(binary instanceof ArrayBuffer) && !ArrayBuffer.isView(binary)) throw new Error("Import bytes must be an ArrayBuffer or typed array");
  const byteLength = binary instanceof ArrayBuffer ? binary.byteLength : binary.byteLength;
  if (byteLength <= 0) throw new Error("Import bytes must not be empty");
  const folder = await localFileSystem.getTemporaryFolder();
  const entry = await folder.createFile(`${randomId("import")}-${safeName}`, { overwrite: false });
  try {
    await entry.write(binary, { format: binaryFormat });
    return entry;
  } catch (error) {
    await deleteEntry(entry).catch(() => {});
    throw error;
  }
}

async function deleteEntry(entry) {
  if (entry && typeof entry.delete === "function") await entry.delete();
}

module.exports = {
  getToken,
  setToken,
  clearToken,
  getServer,
  setServer,
  clearServer,
  getPluginInstanceId,
  chooseExportFolder,
  getExportFolder,
  resolvePersistentEntry,
  createTemporaryExportFile,
  readEntryBinary,
  materializeTemporaryImportFile,
  deleteEntry,
  randomId
};
