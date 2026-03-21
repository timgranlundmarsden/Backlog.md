# Supabase Data Layer for Backlog.md — Analysis & Plan

## Context

**Problem:** When agents work on tasks in remote branches, editing those tasks requires pulling the branch, editing markdown files, and pushing back. This is friction-heavy and error-prone. Multiple agents need a single realtime source of truth.

**Solution:** Supabase as the realtime coordination layer + markdown files synced to disk so task diffs are committed alongside the code. "Everything as code" with a proper database behind it.

**Key insight:** The codebase already has a clean three-tier architecture (`FileSystem` → `Core` → `CLI/MCP`), with a single `FileSystem` class handling ALL data I/O. This makes a storage backend swap feasible with minimal blast radius.

### Architecture

```
Agents/MCP/CLI ──write──► Supabase (realtime source of truth)
                              │
                              ▼
                     Sync to disk (markdown files)
                              │
                              ▼
                     git commit alongside code
```

- **Supabase** is where all reads and writes happen. Agents get instant cross-agent visibility via Realtime subscriptions.
- **Markdown files on disk** are regenerated after each Supabase write. They get committed alongside implementation code, so `git log` shows task evolution with the code. The repo is a self-contained knowledge archive.
- **Local-only mode** remains a first-class citizen (no Supabase needed for single-user/offline workflows).

### Why Not GitHub Issues/Projects V2?

Evaluated in detail in `docs/github-data-layer-analysis.md`. Summary: GitHub's data model (50-field limit, no array types, mandatory body parsing, no atomic section updates, GraphQL-only for Projects V2) makes it a poor fit for structured task storage. GitHub remains useful for what it's designed for — issue tracking, PRs, and kanban views.

---

## Options Evaluated

### Option A: Replace FileSystem entirely (no local files)
**Rejected.** Loses git history of task changes, breaks offline workflows, and removes the "everything as code" benefit where task context travels with the codebase.

### Option B: Supabase + File Sync to Git (Recommended)
Supabase is the realtime source of truth. After every write, the affected task's markdown file is regenerated on disk. Files get committed with the code. The sync is primarily unidirectional (Supabase → disk), keeping complexity low.

**Why this works:**
- Both CLI and MCP already flow through `Core.fs` (a single `FileSystem` instance)
- `FileSystem` has ~38 public methods — the interface is well-defined
- Existing markdown parser/serializer reused for the sync-to-disk step
- **724 lines of cross-branch task loading code (`TaskLoader`) become unnecessary** — Supabase eliminates cross-branch coordination
- ContentStore file watchers can be replaced with Supabase Realtime subscriptions
- Git history preserved — task diffs appear alongside code diffs
- Offline reading always works — files are on disk

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
| `description` | TEXT | ## Description section |
| `implementation_plan` | TEXT | ## Implementation Plan section |
| `implementation_notes` | TEXT | ## Implementation Notes section |
| `final_summary` | TEXT | ## Final Summary section |
| `acceptance_criteria` | JSONB | `[{text, checked}]` — checkbox items |
| `definition_of_done` | JSONB | `[{text, checked}]` — checkbox items |

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

**Read flow (DB → Task):** Query returns all columns. Map directly to Task object fields — no markdown parsing needed. AC/DoD come back as JSONB arrays of `{text, checked}`.

**Write flow (Task → DB → Disk):** Map Task object fields directly to columns — no markdown serialization needed for the DB write. After the DB write succeeds, regenerate the affected task's markdown file on disk using the existing serializer. This is the sync-to-disk step that keeps files current for git commits.

**Migration flow (file → DB):** Uses existing markdown parser to extract sections from files, then maps each section to its column. This is the only place the parser is needed for Supabase mode.

**Sync-to-disk flow (DB → file):** After every Supabase mutation, reconstruct the full markdown file from DB columns using the existing serializer, write it to the appropriate path on disk. This happens automatically in the storage layer — callers don't need to know about it.

### 5. ContentStore Adaptation

- `patchFilesystem` interception pattern still works (same method names)
- File watchers remain for local mode; Supabase Realtime subscriptions added as an alternative path in supabase mode
- `refreshFromDisk` stays as-is; a parallel `refreshFromDb` method added for supabase mode (same logic: load all, diff, notify)

### 6. File Sync Layer

The core of the hybrid approach. After every Supabase write, the affected entity's markdown file is regenerated on disk.

```
SupabaseStorage.saveTask(task)
  → UPSERT to Supabase
  → on success: serialize task to markdown via existing serializer
  → write to backlog/tasks/{id}.md (or completed/, archive/, drafts/)
```

**Design principles:**
- Sync is fire-and-forget after DB success — the DB write is the authoritative action
- Uses the existing `FileSystem` serializer to produce identical markdown format
- Files land in the same directory structure as local-only mode
- Downstream git operations (add, commit) are the caller's responsibility — the storage layer just writes the file

**Reverse sync (Disk → Supabase):**

When a file is edited on disk directly (manual edit, `openInEditor`, or another tool), changes must be persisted back to Supabase automatically.

**Detection:** File watcher (already exists in ContentStore) detects file changes. In Supabase mode, instead of just updating the in-memory store, it also writes the changes to Supabase.

**Collision prevention:** Use optimistic locking via `updated_at`:
1. File watcher detects change → parse the file
2. Read current `updated_at` from Supabase for that task
3. UPDATE ... SET fields WHERE id = ? AND updated_at = ? (the value we last synced)
4. If the UPDATE matches 0 rows → someone else updated the DB since our last sync → conflict
5. On conflict: re-fetch from Supabase, re-sync to disk (Supabase wins), notify user

**Avoiding echo loops:** When the storage layer itself writes a file (Supabase → disk sync), it sets a short-lived ignore flag so the file watcher doesn't treat it as a manual edit and try to write it back to Supabase.

**Startup reconciliation:** On startup, compare file `updated_date` frontmatter against DB `updated_at`. If file is newer, upsync. If DB is newer, re-sync to disk. This handles edits made while the process was not running.

### 7. What Gets Bypassed in Supabase Mode

Since both storage modes coexist permanently, no existing code is removed. The following code paths are simply **skipped** when `storage: "supabase"` is active:

- **TaskLoader** (724 lines) — cross-branch loading is skipped (early return), but the code stays for local mode users
- **Git auto-commit for data changes** — skipped since DB is source of truth, but remains for local mode
- **Cross-branch task resolution** — skipped, but code remains intact
- **`source` field on tasks** — always set to a default value, but the field and its handling remain
- **File watchers in ContentStore** — not started in Supabase mode, but the code remains for local mode

**Nothing is deleted.** Local mode is a permanent first-class citizen.

### 8. The `openInEditor` Flow

Since files are always synced to disk, `openInEditor` works exactly as today — open the markdown file, user edits, save. The only addition: after the editor closes, detect changes and write them back to Supabase (see File Watcher below).

No temp files needed. The file on disk IS the editing surface.

### 9. Migration Tooling

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
| **4. File sync layer** | After each Supabase write, regenerate markdown file on disk using existing serializer | `src/supabase/storage.ts`, `src/supabase/sync.ts` (new) | Low — uses existing serializer |
| **5. Disk-to-Supabase sync** | File watcher detects local edits, parses changed file, writes back to Supabase with optimistic locking | `src/supabase/sync.ts` | Medium — needs collision handling |
| **6. Remaining entities** | Milestones, decisions, documents, config in SupabaseStorage | `src/supabase/storage.ts` | Low |
| **7. ContentStore realtime** | Supabase Realtime subscriptions instead of file watchers | `src/core/content-store.ts`, `src/supabase/realtime.ts` (new) | Medium |
| **8. Bypass cross-branch** | Add early returns to skip TaskLoader/cross-branch paths in supabase mode (code stays for local mode) | `src/core/backlog.ts` | Low |
| **9. Migration command** | `migrate-to-supabase` + `export-to-files` CLI commands | `src/supabase/migration.ts` (new), `src/cli.ts` | Low |

**Estimated new code:** ~1,500 LOC
**Estimated modified code:** ~140 LOC across existing files
**No existing files deleted** — all local-mode code remains fully functional
**New dependency:** `@supabase/supabase-js`

---

## Tradeoffs & Considerations

| Aspect | Local (current) | Supabase + File Sync |
|--------|----------------|----------------------|
| Offline editing | Works | Reading works (files on disk). Writing requires network. |
| Branch coordination | Required (the pain point) | Eliminated — Supabase is branch-independent |
| Setup complexity | Zero | Supabase project + env var |
| Query performance | Load-all-then-filter | SQL WHERE clauses |
| Real-time updates | File watchers | Supabase Realtime |
| Data portability | Markdown files in repo | Markdown files in repo (synced from Supabase) |
| Git history of tasks | Automatic | **Preserved** — file sync means task diffs commit with code |
| Knowledge archive | Files in repo | Files in repo (same — everything as code) |

**Key benefit:** You keep git history of task changes AND gain centralized, branch-independent access for all agents. The sync-to-disk step preserves the "everything as code" model.

**Design decision:** Both storage modes coexist permanently as a config switch. Local files remain the default for open-source/single-user workflows. Supabase is opt-in for teams/multi-agent workflows. Both are first-class citizens.

---

## Verification Plan

1. **Phase 1 (interface extraction):** Run `bun test` — all existing tests must pass unchanged
2. **Phase 2-3 (SupabaseStorage):** Unit tests against a Supabase test instance — CRUD for all entity types
3. **Phase 4 (file sync):** After Supabase write, verify markdown file exists on disk with correct content. Round-trip: write to Supabase → file synced → read file → matches original task
4. **Phase 6 (Realtime):** Integration test: update task via Supabase client, verify ContentStore emits change event
5. **Phase 9 (Migration):** Round-trip test: migrate local files → Supabase → verify files on disk match originals
6. **End-to-end:** Run `backlog task create`, `backlog task list`, `backlog task edit` with `storage: supabase` config. Verify files on disk update after each operation. Commit files alongside code and check git diff shows task changes.
