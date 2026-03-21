# Supabase Data Layer for Backlog.md — Analysis & Plan

## Context

**Problem:** When agents work on tasks in remote branches, editing those tasks requires pulling the branch, editing markdown files, and pushing back. This is friction-heavy and error-prone.

**Solution:** Replace the local filesystem storage with a centralized Supabase database so all agents and humans see the same task data regardless of which branch they're on. The concept of "remote task files" disappears entirely.

**Key insight:** The codebase already has a clean three-tier architecture (`FileSystem` → `Core` → `CLI/MCP`), with a single `FileSystem` class handling ALL data I/O. This makes a storage backend swap feasible with minimal blast radius.

---

## Options Evaluated

### Option A: Bidirectional Sync (Local Files + Supabase)
**Rejected.** Bidirectional sync is notoriously complex (~3,000-4,000 LOC), creates two sources of truth, and requires conflict resolution. The opposite of minimal.

### Option B: Replace FileSystem with SupabaseStorage (Recommended)
Create a `SupabaseStorage` class with the same public API as `FileSystem`, backed by Supabase tables. Task metadata lives in columns (queryable), markdown body in a `text` column (preserving formatting). Core gets a config switch to pick storage backend.

**Why this works:**
- Both CLI and MCP already flow through `Core.fs` (a single `FileSystem` instance)
- `FileSystem` has ~38 public methods — the interface is well-defined
- Existing markdown parser/serializer can be reused at the boundary
- **724 lines of cross-branch task loading code (`TaskLoader`) become unnecessary**
- ContentStore file watchers can be replaced with Supabase Realtime subscriptions

---

## Recommended Approach: Detailed Design

### 1. Supabase Schema

**`projects`** — multi-project isolation:
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | auto-generated |
| `slug` | TEXT UNIQUE | used in config |
| `name` | TEXT | |

**`tasks`** — unified table for active/completed/archived/draft:
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT | e.g. "BACK-378" (composite PK with project_id) |
| `project_id` | UUID FK | → projects.id |
| `title` | TEXT | |
| `status` | TEXT | e.g. "To Do", "In Progress", "Done" |
| `category` | TEXT | 'active' / 'completed' / 'archived' / 'draft' |
| `assignee` | TEXT[] | Postgres array |
| `reporter` | TEXT | |
| `created_date` | TEXT | |
| `updated_date` | TEXT | |
| `labels` | TEXT[] | |
| `milestone` | TEXT | |
| `dependencies` | TEXT[] | |
| `references` | TEXT[] | |
| `documentation` | TEXT[] | |
| `parent_task_id` | TEXT | |
| `priority` | TEXT | high/medium/low |
| `ordinal` | NUMERIC | |
| `markdown_body` | TEXT | everything below frontmatter |

Instead of separate directories (tasks/, completed/, archive/, drafts/), the `category` column distinguishes state. `archiveTask` = UPDATE category to 'archived'. `completeTask` = UPDATE category to 'completed'.

**`milestones`**, **`decisions`**, **`documents`**, **`configs`** — similar pattern, one table each.

### 2. Authentication Model (Minimal)

- Config gets two new fields: `supabase_url` and `supabase_project` (slug)
- API key stored in env var `BACKLOG_SUPABASE_KEY` (not committed to repo)
- RLS policies scope all queries by `project_id`
- All users/agents connecting to the same project see the same data

### 3. Storage Interface Extraction

Extract a `StorageInterface` type from `FileSystem`'s public surface (~25 methods + directory accessors). Both `FileSystem` and `SupabaseStorage` implement it.

```
Core.fs: FileSystem  →  Core.storage: StorageInterface
```

This is a pure refactor step with zero behavior change — can be shipped and tested independently.

### 4. SupabaseStorage Class

New `src/supabase/storage.ts` implements `StorageInterface`:

| FileSystem method | Supabase equivalent |
|---|---|
| `saveTask(task)` | UPSERT into tasks, columns from frontmatter, body into markdown_body |
| `loadTask(id)` | SELECT WHERE id = ? AND category = 'active' |
| `listTasks(filter?)` | SELECT WHERE category = 'active' + optional WHERE clauses |
| `completeTask(id)` | UPDATE SET category = 'completed' |
| `archiveTask(id)` | UPDATE SET category = 'archived' |
| `listDrafts()` | SELECT WHERE category = 'draft' |
| `promoteDraft(id)` | UPDATE category 'draft' → 'active', assign new task ID |
| `loadConfig()` | SELECT from configs table |
| ... | (same pattern for milestones, decisions, documents) |

**Read flow (DB → Task):** Query returns columns + `markdown_body`. Structured fields come directly from columns. Body sections (description, AC, DoD, notes) parsed from `markdown_body` using existing section parser.

**Write flow (Task → DB):** Extract frontmatter fields into columns. Serialize body sections into `markdown_body` using existing serializer (strip frontmatter portion).

### 5. ContentStore Adaptation

- `patchFilesystem` interception pattern still works (same method names)
- File watchers replaced with Supabase Realtime subscriptions in supabase mode
- `refreshFromDisk` → `refreshFromDb` (same logic: load all, diff, notify)

### 6. What Gets Eliminated/Simplified

- **TaskLoader** (724 lines) — no-ops in Supabase mode. No branches to search.
- **Git auto-commit for data changes** — DB is source of truth, no files to commit
- **Cross-branch conflict resolution** — gone
- **`source` field complexity** — always "local" equivalent, everything is centralized
- **Remote operations config** — irrelevant

### 7. The `openInEditor` Problem

Currently opens the markdown file directly. With Supabase, there's no file.

**Solution:** Same pattern as `git commit` — write task to temp file, open editor, read back on close, update DB, delete temp file. Small change in 2-3 Core methods.

### 8. Migration Tooling

New CLI command: `backlog migrate-to-supabase`
1. Reads all local markdown files via existing FileSystem
2. Inserts into Supabase tables
3. Updates config to `storage: supabase`

Reverse command: `backlog export-to-files` — dumps DB back to markdown files (safety net).

---

## Implementation Sequence

| Phase | What | Files | Risk |
|-------|------|-------|------|
| **1. Interface extraction** | Extract `StorageInterface`, make `FileSystem` implement it, change `Core.fs` type | `src/types/storage.ts` (new), `src/file-system/operations.ts`, `src/core/backlog.ts` | None — pure refactor |
| **2. SupabaseStorage core** | Implement task/draft CRUD against Supabase | `src/supabase/storage.ts` (new), `src/supabase/client.ts` (new) | Low — new code, isolated |
| **3. Config switch** | Add `storage` field to config, Core picks backend | `src/types/index.ts`, `src/core/backlog.ts` | Low |
| **4. Remaining entities** | Milestones, decisions, documents, config in SupabaseStorage | `src/supabase/storage.ts` | Low |
| **5. ContentStore realtime** | Supabase Realtime subscriptions instead of file watchers | `src/core/content-store.ts`, `src/supabase/realtime.ts` (new) | Medium |
| **6. Editor flow** | Temp-file pattern for openInEditor | `src/core/backlog.ts` | Low |
| **7. Simplify cross-branch** | Skip TaskLoader in supabase mode | `src/core/backlog.ts` | Low |
| **8. Migration command** | `migrate-to-supabase` + `export-to-files` CLI commands | `src/supabase/migration.ts` (new), `src/cli.ts` | Low |

**Estimated new code:** ~1,500 LOC
**Estimated modified code:** ~140 LOC across existing files
**New dependency:** `@supabase/supabase-js`

---

## Tradeoffs & Considerations

| Aspect | Local (current) | Supabase |
|--------|----------------|----------|
| Offline editing | Works | Requires network |
| Branch coordination | Required (the pain point) | Eliminated |
| Setup complexity | Zero | Supabase project + env var |
| Query performance | Load-all-then-filter | SQL WHERE clauses |
| Real-time updates | File watchers | Supabase Realtime |
| Data portability | Markdown files in repo | Export command needed |
| Git history of tasks | Automatic | Lost (DB is source of truth) |

**Key tradeoff:** You lose git history of task changes and offline editing. You gain centralized, branch-independent access for all agents and users.

**Design decision:** Both storage modes coexist permanently as a config switch. Local files remain the default for open-source/single-user workflows. Supabase is opt-in for teams/multi-agent workflows. Both are first-class citizens.

---

## Verification Plan

1. **Phase 1 (interface extraction):** Run `bun test` — all existing tests must pass unchanged
2. **Phase 2-4 (SupabaseStorage):** Unit tests against a Supabase test instance — CRUD for all entity types
3. **Phase 5 (Realtime):** Integration test: update task via Supabase client, verify ContentStore emits change event
4. **Phase 8 (Migration):** Round-trip test: migrate local files → Supabase → export back to files → diff should be empty
5. **End-to-end:** Run `backlog task create`, `backlog task list`, `backlog task edit` with `storage: supabase` config
