"use strict";

class PluginError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
  }
}

function normalizeError(error) {
  if (error instanceof PluginError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const message = error && error.message ? error.message : String(error);
  const lower = message.toLowerCase();
  let code = "HOST_ERROR";
  if (lower.includes("modal")) code = "MODAL_BUSY";
  else if (lower.includes("cancel")) code = "CANCELLED";
  else if (lower.includes("timeout") || lower.includes("deadline")) code = "TIMEOUT";
  return { code, message };
}

module.exports = { PluginError, normalizeError };
