// Shared paths of the Agent Office installation (not of a department workspace).

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OFFICE_DIR = path.join(ROOT, "office");
export const TEMPLATES_DIR = path.join(ROOT, "templates");
export const TEMPLATE_AGENTS_DIR = path.join(TEMPLATES_DIR, "agents");
export const TEMPLATE_STAFF_FILE = path.join(TEMPLATES_DIR, "staff.json");
export const TEMPLATE_WORKSPACE_DIR = path.join(TEMPLATES_DIR, "workspace");
export const DEFAULT_WORKSPACE_ROOT = path.join(ROOT, "workspace");
export const DASHBOARD_DIR = path.join(ROOT, "dashboard");
