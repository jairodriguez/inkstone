import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { SqlJsDatabase } from "../db/schema.js";
import { initDb, writeChunk, searchWiki, getChunk, closeDb } from "../db/schema.js";
import { rebuildFtsIndex } from "../db/fts.js";

let db: SqlJsDatabase;
let tmpDir: string;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "inkstone-test-"));
  db = await initDb(join(tmpDir, "test.db"));
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Wiki versioning (simulated via direct DB ops)", () => {
  it("creates initial wiki chunk with valid_from set", () => {
    const now = new Date().toISOString();
    const id = "entities/test-entity.md::0";
    const h = "abc123";

    db.run(
      `INSERT INTO chunks (id, path, source, namespace, knowledge_type, lifecycle,
                           start_line, end_line, hash, text, half_life_days, valid_from, created_at, updated_at)
       VALUES (?, ?, 'wiki', '/general', 'fact', 'active', 1, 10, ?, 'Initial content', 30, ?, ?, ?)`,
      [id, "entities/test-entity.md", h, now, now, now]
    );

    const chunk = getChunk(db, id);
    assert.ok(chunk);
    assert.ok(chunk.valid_from, "valid_from should be set");
    assert.equal(chunk.valid_to, null, "valid_to should be NULL for current version");
  });

  it("versions wiki chunk: old gets valid_to, new row with suffixed ID + supersedes edge", () => {
    const now = new Date().toISOString();
    const oldId = "entities/test-entity.md::0";
    const newId = `entities/test-entity.md::0::v${Date.now()}`;
    const newHash = "def456";

    db.run("UPDATE chunks SET valid_to = ? WHERE id = ? AND valid_to IS NULL", [now, oldId]);

    db.run(
      `INSERT INTO chunks (id, path, source, namespace, knowledge_type, lifecycle,
                           start_line, end_line, hash, text, half_life_days, valid_from, created_at, updated_at)
       VALUES (?, ?, 'wiki', '/general', 'fact', 'active', 1, 10, ?, 'Updated content', 30, ?, ?, ?)`,
      [newId, "entities/test-entity.md", newHash, now, now, now]
    );

    db.run(
      "INSERT INTO memory_relations (id, from_chunk_id, to_chunk_id, relation_type, weight) VALUES (?, ?, ?, 'supersedes', 2.0)",
      [`supersedes:${newId}:${oldId}`, newId, oldId]
    );

    const oldChunk = getChunk(db, oldId);
    assert.ok(oldChunk);
    assert.ok(oldChunk.valid_to, "old chunk should have valid_to");
    assert.equal(String(oldChunk.text), "Initial content");

    const newChunk = getChunk(db, newId);
    assert.ok(newChunk);
    assert.equal(newChunk.valid_to, null, "new chunk should have valid_to NULL");
    assert.equal(String(newChunk.text), "Updated content");

    const edges = db.exec("SELECT count(*) FROM memory_relations WHERE relation_type = 'supersedes'");
    assert.equal(edges[0].values[0][0], 1);
  });
});

describe("Decision supersession via replaces", () => {
  it("writeChunk with replaces marks old chunk stale and creates supersedes edge", () => {
    const oldId = writeChunk(db, {
      text: "Use Stripe for payments",
      namespace: "/business/decisions",
      path: "decisions/payment-provider",
    });
    assert.ok(oldId);

    const newId = writeChunk(db, {
      text: "Use Paddle for payments instead of Stripe",
      namespace: "/business/decisions",
      path: "decisions/payment-provider-v2",
      replaces: oldId,
    });
    assert.ok(newId);
    assert.notEqual(newId, oldId);

    const oldChunk = getChunk(db, oldId);
    assert.ok(oldChunk);
    assert.equal(oldChunk.lifecycle, "stale");
    assert.ok(oldChunk.valid_to, "old chunk should have valid_to set");

    const newChunk = getChunk(db, newId);
    assert.ok(newChunk);
    assert.equal(newChunk.lifecycle, "active");
    assert.equal(newChunk.valid_to, null);

    const supersedes = db.exec(
      "SELECT count(*) FROM memory_relations WHERE relation_type = 'supersedes' AND from_chunk_id = ? AND to_chunk_id = ?",
      [newId, oldId]
    );
    assert.equal(supersedes[0].values[0][0], 1, "should have supersedes edge");
  });

  it("replaces with nonexistent ID is a no-op", () => {
    const id = writeChunk(db, {
      text: "Some decision",
      replaces: "nonexistent-chunk-id",
    });
    assert.ok(id);

    const chunk = getChunk(db, id);
    assert.ok(chunk);
    assert.equal(chunk.lifecycle, "active");
  });
});

describe("Search excludes stale/superseded", () => {
  it("searchWiki does not return stale chunks by default", () => {
    rebuildFtsIndex(db);

    const results = searchWiki(db, { query: "Stripe payments", namespace: "/business" });
    const hasStale = results.some((r) => r.text.includes("Use Stripe for payments") && !r.text.includes("Paddle"));
    assert.equal(hasStale, false, "stale Stripe decision should not appear");
  });

  it("searchWiki returns the new superseding chunk", () => {
    const results = searchWiki(db, { query: "Paddle payments", namespace: "/business" });
    const hasPaddle = results.some((r) => r.text.includes("Paddle"));
    assert.ok(hasPaddle, "new Paddle decision should appear");
  });

  it("searchWiki does not return versioned wiki chunks (valid_to set)", () => {
    rebuildFtsIndex(db);

    const results = searchWiki(db, { query: "Initial content" });
    const hasOld = results.some((r) => r.text.includes("Initial content") && !r.text.includes("Updated"));
    assert.equal(hasOld, false, "old wiki version should not appear");
  });
});
