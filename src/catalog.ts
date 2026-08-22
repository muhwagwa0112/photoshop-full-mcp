import { Ajv, type ValidateFunction } from "ajv";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityStatus, CommandDefinition, FeatureDefinition } from "../packages/contracts/src/index.js";
import { PhotoshopMcpError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));

export class CommandCatalog {
  private readonly commands = new Map<string, CommandDefinition>();
  private features: FeatureDefinition[] = [];
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

  static async load(path = join(here, "..", "catalog", "commands.json")): Promise<CommandCatalog> {
    const catalog = new CommandCatalog();
    const commands = JSON.parse(await readFile(path, "utf8")) as CommandDefinition[];
    for (const command of commands) catalog.register(command);
    const featurePath = join(dirname(path), "features.json");
    catalog.features = JSON.parse(await readFile(featurePath, "utf8")) as FeatureDefinition[];
    return catalog;
  }

  register(command: CommandDefinition): void {
    if (this.commands.has(command.id)) throw new Error(`Duplicate command id: ${command.id}`);
    this.commands.set(command.id, command);
    this.validators.set(command.id, this.ajv.compile(command.inputSchema));
  }

  list(filters: { status?: CapabilityStatus; category?: string; query?: string } = {}): CommandDefinition[] {
    const query = filters.query?.trim().toLocaleLowerCase();
    return [...this.commands.values()].filter((command) => {
      if (filters.status && command.status !== filters.status) return false;
      if (filters.category && command.category !== filters.category) return false;
      if (!query) return true;
      return [command.id, command.category, command.labels.en, command.labels.ko, command.description]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    });
  }

  listFeatures(filters: { status?: CapabilityStatus; category?: string; query?: string } = {}): FeatureDefinition[] {
    const query = filters.query?.trim().toLocaleLowerCase();
    return this.features.filter((feature) => {
      if (filters.status && feature.status !== filters.status) return false;
      if (filters.category && feature.category !== filters.category) return false;
      if (!query) return true;
      return [feature.id, feature.category, feature.labelKo, feature.route].join(" ").toLocaleLowerCase().includes(query);
    });
  }

  get(commandId: string): CommandDefinition {
    const command = this.commands.get(commandId);
    if (!command) throw new PhotoshopMcpError("UNSUPPORTED", `Unknown command: ${commandId}`);
    return command;
  }

  validate(commandId: string, args: unknown): Record<string, unknown> {
    const validate = this.validators.get(commandId);
    if (!validate) throw new PhotoshopMcpError("UNSUPPORTED", `Unknown command: ${commandId}`);
    const value = structuredClone((args ?? {}) as Record<string, unknown>);
    if (!validate(value)) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", `Invalid arguments for ${commandId}`, validate.errors);
    }
    return value;
  }
}
