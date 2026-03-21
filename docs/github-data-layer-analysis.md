# GitHub as Centralized Data Layer — Feasibility Analysis

> Alternative to Supabase for centralized task storage, using GitHub's own infrastructure.

## Why Consider This

The code already lives in GitHub. Using GitHub Issues + Projects V2 as the data layer means:

- **Zero new dependencies** — no Supabase, no `@supabase/supabase-js`, no external DB
- **Data lives next to the code** — issues, PRs, and tasks in one place
- **Built-in auth** — GitHub tokens already exist; no separate auth system
- **Free for public repos** — no hosting costs
- **Native integrations** — GitHub Actions, webhooks, branch linking, PR references all work out of the box
- **`gh` CLI** — already available in most CI/CD and dev environments

---

## Two Approaches Evaluated

### Approach A: GitHub Issues as Primary Store

Each Backlog.md task becomes a GitHub Issue. Metadata stored via a combination of native fields, labels, and Projects V2 custom fields.

### Approach B: GitHub Projects V2 Draft Items as Primary Store

Each task is a Projects V2 item (draft or linked issue). Custom fields on the project hold all structured data.

---

## Approach A: GitHub Issues

### Field Mapping

| Backlog.md Field | GitHub Issue Field | Fit |
|---|---|---|
| `id` (BACK-123) | Issue `#number` | **Poor** — can't control numbering or prefix |
| `title` | Issue `title` | Native |
| `status` | Project column / single-select field | Via Projects V2 |
| `assignee[]` | Issue `assignees` | Native (multiple supported) |
| `reporter` | Issue `author` (read-only) or custom field | Partial — author is immutable |
| `createdDate` | Issue `created_at` (read-only) | Native but immutable |
| `updatedDate` | Issue `updated_at` (auto) | Native but auto-managed |
| `labels[]` | Issue `labels` | Native |
| `milestone` | Issue `milestone` | Native |
| `priority` | Label (`priority:high`) or Project field | Via convention or Projects V2 |
| `dependencies[]` | Body section or Project field | Manual — no native deps |
| `references[]` | Body links (auto-linked) | Partial |
| `documentation[]` | Body section | Manual |
| `parentTaskId` | Sub-issue (beta) or body reference | Partial — sub-issues are new/limited |
| `subtasks[]` | Task lists in body or sub-issues | Partial |
| `ordinal` | Project field (number) | Via Projects V2 |
| `description` | Issue body (section) | **Body parsing required** |
| `implementationPlan` | Issue body (section) or comment | **Body parsing required** |
| `implementationNotes` | Issue body (section) or comment | **Body parsing required** |
| `finalSummary` | Issue body (section) or comment | **Body parsing required** |
| `acceptanceCriteria[]` | Task list checkboxes in body | **Body parsing required** |
| `definitionOfDone[]` | Task list checkboxes in body | **Body parsing required** |
| `category` (active/completed/archived/draft) | Open/closed + labels | Convention-based |
| `onStatusChange` | N/A | **No equivalent** |

### Body Structure (Structured Markdown)

To store the content sections, the issue body would need structured markers:

```markdown
## Description
The task description here...

## Implementation Plan
<!-- SECTION:PLAN -->
Steps to implement...

## Acceptance Criteria
- [x] First criterion
- [ ] Second criterion

## Definition of Done
- [ ] Tests pass
- [ ] Docs updated

## Implementation Notes
<!-- SECTION:NOTES -->
Progress updates...

## Final Summary
<!-- SECTION:FINAL_SUMMARY -->
What was done...
```

This is **parsing markdown in the issue body** — the same problem the Supabase plan originally had with `markdown_body`. Every read/write requires parsing and re-serializing the body.

### Limits

| Resource | Limit |
|---|---|
| Issue body size | ~65,536 characters (mediumblob) |
| Labels per issue | No documented hard limit |
| Milestones per repo | No documented hard limit |
| Issues per repo | No hard limit (but performance degrades) |
| REST API rate | 5,000 requests/hour (authenticated) |
| GraphQL API rate | 5,000 points/hour |

### Problems

1. **No custom IDs** — GitHub assigns `#1`, `#2`, etc. Backlog.md uses `BACK-123` with configurable prefixes. You'd need a mapping layer or abandon custom IDs.

2. **Body parsing is unavoidable** — Description, implementation plan, AC, DoD, notes, and final summary all live in the issue body as markdown sections. Every update requires parsing the full body, modifying one section, and writing it back. Race conditions on concurrent edits.

3. **No atomic field updates** — To update just the implementation notes, you must read the entire body, parse it, modify the section, serialize it, and write the whole body back. Compare with Supabase: `UPDATE tasks SET implementation_notes = $1 WHERE id = $2`.

4. **Reporter is immutable** — `issue.author` is whoever created it. Can't set `reporter` to a different person after creation.

5. **Dependencies are free-text** — No native dependency tracking between issues. Must be stored in body or comments and parsed.

6. **Rate limits constrain batch operations** — Loading 200 tasks = 200 API calls (or batched GraphQL queries that consume points). Local file reads are instant.

7. **Decisions and Documents don't fit** — Issues are typed as "issue". There's no clean way to represent decisions (`decision-1`) and documents (`doc-1`) as issues without label conventions that feel hacky.

---

## Approach B: GitHub Projects V2

### How It Works

Projects V2 supports **draft items** (no backing issue required) and **custom fields** on every item. This is closer to a database model.

### Field Mapping via Custom Fields

| Backlog.md Field | Projects V2 Field Type | Notes |
|---|---|---|
| `id` (BACK-123) | Text field | Custom — stored as text, not GitHub's `#number` |
| `title` | Built-in Title | Native |
| `status` | Single select | Native (maps to board columns) |
| `assignee[]` | Built-in Assignees | Only works for issue-backed items, not drafts |
| `priority` | Single select | Custom field |
| `milestone` | Single select or text | Custom field |
| `labels[]` | Text field (comma-separated) or multiple single selects | **Awkward** — no native array field type |
| `ordinal` | Number field | Custom field |
| `createdDate` | Date field | Custom field |
| `updatedDate` | Date field | Custom field |
| `dependencies[]` | Text field | No native linking |
| `category` | Single select | active/completed/archived/draft |
| `description` | Draft body text | In the item body |
| `implementationPlan` | Text field or body section | Custom field has unknown size limit |
| `implementationNotes` | Text field or body section | Same concern |
| `acceptanceCriteria` | Body checkboxes | Must be in body — no JSONB equivalent |
| `definitionOfDone` | Body checkboxes | Same |

### Limits

| Resource | Limit |
|---|---|
| Items per project | **50,000** (as of Feb 2025 public preview) |
| Custom fields per project | **50** |
| Single select options per field | **50** |
| Text field size | Not documented — likely ~65K chars |
| GraphQL rate | 5,000 points/hour |

### Problems

1. **50-field limit is tight** — Backlog.md tasks have ~20+ fields. Add milestones, decisions, and documents to the same project and you're sharing those 50 fields. With 4 entity types × ~10 fields each, you hit the cap.

2. **No array fields** — `labels[]`, `dependencies[]`, `references[]`, `documentation[]`, `subtasks[]`, `assignee[]` are all arrays. Projects V2 has no array/multi-value field type. You'd need to serialize arrays as comma-separated text and parse them back.

3. **Draft items can't have assignees** — The assignees field only works when the item is linked to an issue. Draft items don't support it. So you'd need to either: always create backing issues (making drafts heavier), or use a text field for assignees (losing GitHub user linking).

4. **Body still needs section parsing** — Long-form content (description, implementation plan, notes, AC, DoD) would need to go in the item body because text custom fields likely can't hold multi-paragraph markdown well. Same parsing problem as Issues.

5. **Mixed entity types in one project** — Tasks, decisions, documents, and milestones would all be items in the same project, differentiated by a "type" single-select field. Filtering works but the field namespace is shared and messy.

6. **No realtime subscriptions** — Supabase has Realtime (WebSocket push). GitHub has webhooks (requires a server to receive them) or polling. For the MCP/web UI, you'd need to poll on an interval.

7. **GraphQL-only API** — All Projects V2 operations require GraphQL. The mutations are verbose and require knowing field node IDs. Compare:
   - **Supabase:** `supabase.from('tasks').update({status: 'Done'}).eq('id', 'BACK-123')`
   - **GitHub:** Requires 2-3 GraphQL calls — get project ID, get field ID, get item ID, then `updateProjectV2ItemFieldValue`

8. **No transactions** — Supabase/Postgres can update multiple fields atomically. GitHub GraphQL mutations are individual calls — no transactional consistency.

---

## Side-by-Side Comparison

| Dimension | GitHub Issues | GitHub Projects V2 | Supabase |
|---|---|---|---|
| **Custom task IDs** (BACK-123) | No — uses #number | Text field (workaround) | Column — native |
| **Structured fields** | Few native, rest in body | Custom fields (50 max) | Unlimited columns |
| **Array fields** | Labels only | None — serialize to text | JSONB / TEXT[] |
| **Long-form content** | Body (parse sections) | Body (parse sections) | Separate TEXT columns |
| **Checklist items** (AC/DoD) | Body checkboxes (parse) | Body checkboxes (parse) | JSONB arrays |
| **Atomic field updates** | Full body rewrite | Individual field mutations | Single UPDATE |
| **Query/filter** | Label + milestone + assignee | Field-based project views | Full SQL |
| **Full-text search** | Issue search (limited) | No search API | Postgres full-text |
| **Realtime** | Webhooks (need server) | Webhooks (need server) | WebSocket push |
| **Rate limits** | 5,000 req/hr | 5,000 points/hr | Unlimited (self-hosted) |
| **Auth** | GitHub tokens | GitHub tokens | Supabase key + RLS |
| **New dependencies** | None (`gh` CLI) | None (`gh` CLI) | `@supabase/supabase-js` |
| **Cost** | Free (public repos) | Free (public repos) | Free tier or self-host |
| **Multiple entity types** | Labels as type tag | Single-select type field | Separate tables |
| **Decisions / Documents** | Poor fit as issues | Cramped (shared fields) | Dedicated tables |
| **Offline / local-first** | No | No | No (but local mode exists) |
| **Batch operations** | Rate-limited | Rate-limited | Instant |

---

## The Core Problem: Body Parsing

Both GitHub approaches share the same fundamental issue: **long-form content sections must be stored in markdown body text and parsed on every read/write**.

This is exactly the problem that exists today with the file-based approach — content lives in structured markdown that needs parsing. Moving to GitHub just shifts where that markdown lives (issue body instead of local file), without gaining the structured storage benefits that a database provides.

Supabase eliminates this entirely: description, implementation_plan, implementation_notes, final_summary are separate TEXT columns. acceptance_criteria and definition_of_done are JSONB arrays of `{text, checked}`. No parsing needed on the hot path.

---

## Verdict

### GitHub Issues: Not Recommended as Primary Store

- Loses custom IDs entirely (deal-breaker for BACK-123 convention)
- Body parsing for every structured section
- Poor fit for decisions and documents
- No atomic updates to individual sections
- Would be a significant regression from both file-based and Supabase approaches

### GitHub Projects V2: Feasible but Compromised

- Could work for basic task tracking with trade-offs
- 50-field limit forces sharing across entity types
- No array fields means serializing lists as text (back to parsing)
- Draft items lack assignee support
- GraphQL mutation complexity is high
- No realtime — must poll

### Supabase: Best Fit for Structured Storage

- Every field is a column — no parsing
- JSONB for complex structures (AC, DoD)
- Realtime WebSocket subscriptions
- Atomic updates, full SQL queries
- One new dependency (`@supabase/supabase-js`)

### Potential Hybrid: GitHub Issues + Supabase

If keeping data "next to the code" matters, a hybrid could work:

- **Supabase** is the primary store (structured, fast, realtime)
- **GitHub Issues** created as a read-only mirror for visibility (link in task metadata)
- Status changes synced bidirectionally via webhook

This gives the best of both worlds but adds sync complexity.

---

## Recommendation

GitHub's data model is designed for **issue tracking**, not for **structured project management with custom schemas**. The 50-field limit, lack of array types, mandatory body parsing, and absence of atomic updates make it a compromised choice compared to a proper database.

**Use Supabase as the centralized store. Optionally sync to GitHub Issues for visibility.**

If zero-new-dependencies is an absolute hard requirement, GitHub Projects V2 _can_ work, but expect to write and maintain a significant parsing/mapping layer that recreates many of the problems the centralized store was meant to solve.
