/**
 * Inkstone — Multi-User Auth
 *
 * API key authentication, namespace ownership, and access control.
 * Single-user mode: if no users exist, all access is granted (zero config change).
 * Multi-user mode: every request requires a valid API key with namespace permissions.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Database as SqlJsDatabase } from "../db/schema.js";

// ── Types ──────────────────────────────────────────────────────────

export type Role = "admin" | "user";
export type Permission = "read" | "write" | "admin";

export interface User {
  id: string;
  name: string;
  role: Role;
  created_at: string;
}

export interface AuthResult {
  user: User | null;
  isMultiUser: boolean;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function queryOne(db: SqlJsDatabase, sql: string, params: unknown[] = []): Record<string, unknown> | null {
  return db.prepare(sql).get(...params) as Record<string, unknown> | null ?? null;
}

function queryAll(db: SqlJsDatabase, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function generateId(): string {
  return randomBytes(8).toString("hex");
}

function generateApiKey(): string {
  return `ik_${randomBytes(24).toString("base64url")}`;
}

// ── Schema ─────────────────────────────────────────────────────────

export const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS namespace_acl (
  namespace TEXT NOT NULL,
  user_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'write',
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by TEXT,
  PRIMARY KEY (namespace, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_decay_profiles (
  user_id TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  half_life_override REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, memory_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_acl_user ON namespace_acl(user_id);
CREATE INDEX IF NOT EXISTS idx_acl_namespace ON namespace_acl(namespace);
CREATE INDEX IF NOT EXISTS idx_decay_profiles_user ON user_decay_profiles(user_id);
`;

// ── Auth Logic ─────────────────────────────────────────────────────

/**
 * Check if the server is in multi-user mode.
 * If no users exist, it's single-user (open access).
 */
export function isMultiUserMode(db: SqlJsDatabase): boolean {
  const row = queryOne(db, "SELECT COUNT(*) as cnt FROM users");
  return Number(row?.cnt ?? 0) > 0;
}

/**
 * Authenticate a request by API key.
 * Returns { user, isMultiUser } — if not multi-user, user is null and all access is granted.
 * If multi-user but no key provided, returns error.
 */
export function authenticate(db: SqlJsDatabase, apiKey?: string): AuthResult {
  const multiUser = isMultiUserMode(db);

  // Single-user mode: no auth needed
  if (!multiUser) {
    return { user: null, isMultiUser: false };
  }

  // Multi-user mode: key required
  if (!apiKey) {
    return { user: null, isMultiUser: true, error: "API key required (multi-user mode)" };
  }

  const keyHash = hashApiKey(apiKey);
  const row = queryOne(db, "SELECT id, name, role, created_at FROM users WHERE api_key_hash = ?", [keyHash]);

  if (!row) {
    return { user: null, isMultiUser: true, error: "Invalid API key" };
  }

  return {
    user: {
      id: String(row.id),
      name: String(row.name),
      role: String(row.role) as Role,
      created_at: String(row.created_at),
    },
    isMultiUser: true,
  };
}

/**
 * Check if a user has permission on a namespace.
 * In single-user mode, always returns true.
 * Admins always have access.
 * Users with explicit ACL entries are checked.
 * Personal namespaces (/users/{userId}/) are always accessible to the owner.
 */
export function hasPermission(
  db: SqlJsDatabase,
  user: User | null,
  namespace: string,
  requiredPerm: Permission,
): boolean {
  // Single-user mode
  if (!user) return true;

  // Admins can do everything
  if (user.role === "admin") return true;

  // Own personal namespace
  if (namespace.startsWith(`/users/${user.id}/`)) return true;

  // Check ACL
  const acl = queryOne(db,
    "SELECT permission FROM namespace_acl WHERE namespace = ? AND user_id = ?",
    [namespace, user.id],
  );

  if (!acl) return false;

  const perm = String(acl.permission);
  if (perm === "admin") return true;
  if (perm === "write" && (requiredPerm === "write" || requiredPerm === "read")) return true;
  if (perm === "read" && requiredPerm === "read") return true;

  return false;
}

/**
 * Get all namespaces a user can read.
 * Used to scope search results.
 */
export function readableNamespaces(db: SqlJsDatabase, user: User | null): string[] | null {
  // Single-user: null means "all namespaces"
  if (!user) return null;

  // Admin: all
  if (user.role === "admin") return null;

  // Personal + ACL-granted
  const personal = `/users/${user.id}/%`;
  const aclRows = queryAll(db,
    "SELECT namespace FROM namespace_acl WHERE user_id = ?",
    [user.id],
  );

  const namespaces = [`/users/${user.id}`];
  for (const row of aclRows) {
    namespaces.push(String(row.namespace));
  }
  return namespaces;
}

// ── User Management ────────────────────────────────────────────────

export interface CreateUserResult {
  id: string;
  apiKey: string; // Only shown once at creation
  name: string;
  role: Role;
}

/**
 * Create a new user. Returns the API key (shown only once).
 */
export function createUser(
  db: SqlJsDatabase,
  name: string,
  role: Role = "user",
): CreateUserResult {
  const id = generateId();
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO users (id, name, api_key_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, name, keyHash, role, now);

  // Grant the user their personal namespace with admin permission
  db.prepare(
    "INSERT INTO namespace_acl (namespace, user_id, permission, granted_at) VALUES (?, ?, 'admin', ?)",
  ).run(`/users/${id}`, id, now);

  return { id, apiKey, name, role };
}

/**
 * List all users (admin operation).
 */
export function listUsers(db: SqlJsDatabase): Array<{ id: string; name: string; role: string; created_at: string }> {
  return queryAll(db, "SELECT id, name, role, created_at FROM users ORDER BY created_at")
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      role: String(r.role),
      created_at: String(r.created_at),
    }));
}

/**
 * Remove a user and all their ACL entries.
 */
export function removeUser(db: SqlJsDatabase, userId: string): boolean {
  const existing = queryOne(db, "SELECT id FROM users WHERE id = ?", [userId]);
  if (!existing) return false;

  // ACL entries cascade via foreign key, but better-sqlite3 enforces that
  db.prepare("DELETE FROM namespace_acl WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM user_decay_profiles WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  return true;
}

/**
 * Grant a user permission on a namespace.
 */
export function grantPermission(
  db: SqlJsDatabase,
  namespace: string,
  userId: string,
  permission: Permission,
  grantedBy?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO namespace_acl (namespace, user_id, permission, granted_at, granted_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(namespace, user_id) DO UPDATE SET permission = excluded.permission, granted_at = excluded.granted_at`,
  ).run(namespace, userId, permission, now, grantedBy || null);
}

/**
 * Revoke a user's permission on a namespace.
 */
export function revokePermission(db: SqlJsDatabase, namespace: string, userId: string): void {
  db.prepare("DELETE FROM namespace_acl WHERE namespace = ? AND user_id = ?").run(namespace, userId);
}

/**
 * List all ACL entries (optionally filtered by namespace or user).
 */
export function listAcl(
  db: SqlJsDatabase,
  opts?: { namespace?: string; userId?: string },
): Array<{ namespace: string; user_id: string; permission: string; granted_at: string }> {
  let sql = "SELECT namespace, user_id, permission, granted_at FROM namespace_acl WHERE 1=1";
  const params: string[] = [];
  if (opts?.namespace) { sql += " AND namespace = ?"; params.push(opts.namespace); }
  if (opts?.userId) { sql += " AND user_id = ?"; params.push(opts.userId); }
  sql += " ORDER BY namespace, user_id";
  return queryAll(db, sql, params).map((r) => ({
    namespace: String(r.namespace),
    user_id: String(r.user_id),
    permission: String(r.permission),
    granted_at: String(r.granted_at),
  }));
}

/**
 * Set a per-user decay profile override for a memory type.
 */
export function setDecayProfile(
  db: SqlJsDatabase,
  userId: string,
  memoryType: string,
  halfLifeOverride: number | null,
  enabled: boolean = true,
): void {
  db.prepare(
    `INSERT INTO user_decay_profiles (user_id, memory_type, half_life_override, enabled)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, memory_type) DO UPDATE SET half_life_override = excluded.half_life_override, enabled = excluded.enabled`,
  ).run(userId, memoryType, halfLifeOverride, enabled ? 1 : 0);
}

/**
 * Get the effective half-life for a user + memory type.
 * Falls back to the global default if no override exists.
 */
export function getEffectiveHalfLife(
  db: SqlJsDatabase,
  user: User | null,
  memoryType: string,
  defaultHalfLife: number,
): number {
  if (!user) return defaultHalfLife;

  const row = queryOne(db,
    "SELECT half_life_override, enabled FROM user_decay_profiles WHERE user_id = ? AND memory_type = ?",
    [user.id, memoryType],
  );

  if (!row || !Number(row.enabled)) return defaultHalfLife;
  return row.half_life_override !== null ? Number(row.half_life_override) : defaultHalfLife;
}
