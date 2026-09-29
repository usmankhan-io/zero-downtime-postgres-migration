# Zero-Downtime PostgreSQL Schema Migration Engine

[![Read Full Architectural Breakdown](https://img.shields.io/badge/Case_Study-ctousman.com-00d4ff)](https://ctousman.com/blog/zero-downtime-database-migration-engine)

A production-ready framework for migrating PostgreSQL schemas without service interruptions. This engine implements Dual-Writing, Shadow Reads, and an Abstraction Layer to safely transition between schema versions while keeping your application fully live.

> **Full architectural breakdown, war stories, and production lessons:** [ctousman.com/blog/zero-downtime-database-migration-engine](https://ctousman.com/blog/zero-downtime-database-migration-engine)

---

## Core Patterns

### 1. Dual-Writing

Dual-writing means every write operation is sent to **both** the old (primary) schema and the new (target) schema simultaneously. This keeps both schemas in sync during the transition window without requiring a hard cutover.

```
Application Write
       │
       ├──► Primary DB (old schema)  ← canonical source of truth
       │
       └──► Target DB (new schema)   ← new schema, being warmed up
```

**Key properties:**
- The primary write is always authoritative. If the target write fails, it is logged but does not surface as an application error.
- Writes to the target schema are fire-and-forget with error boundaries, so a schema bug in the new version cannot take down production.
- Both databases remain consistent enough to support a safe rollback at any point.

### 2. Shadow Reads

Once dual-writing is stable, Shadow Reads are enabled. A percentage of read traffic is replicated to the new schema, and the results are compared against the primary response — but the **primary result is always returned to the caller**.

```
Application Read
       │
       ├──► Primary DB  ──► response returned to caller
       │
       └──► Target DB   ──► response compared in background (discarded)
                              └── discrepancies logged for analysis
```

**Why this matters:**
- You can validate query correctness and index performance on the new schema under real production load.
- Zero user impact — divergent results from the shadow are never exposed.
- Gives you confidence to increase the shadow read percentage from 1% → 10% → 100% before flipping the cutover flag.

### 3. Abstraction Layer

The Abstraction Layer is a thin middleware that sits between your application logic and the database clients. It owns the routing logic: which operations go to primary, which go to target, and at what percentage.

```
Application Code
       │
       ▼
[ Abstraction Layer ]
  - feature flags (dual-write on/off)
  - shadow read percentage
  - error boundary for target writes
  - discrepancy logger
       │
       ├──► Primary DB Client
       └──► Target DB Client
```

The abstraction layer makes the migration **operationally reversible** — disabling dual-write or shadow reads requires only a config change, not a code deployment.

---

## Dual-Write Middleware — TypeScript Example

```typescript
import { Pool, PoolClient } from 'pg';

interface DualWriteConfig {
  dualWriteEnabled: boolean;
  shadowReadPercent: number; // 0–100
}

class DualWriteMiddleware {
  constructor(
    private primary: Pool,
    private target: Pool,
    private config: DualWriteConfig
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    // Always execute against primary first
    const primaryResult = await this.primary.query(sql, params);

    if (this.config.dualWriteEnabled && this.isWriteOperation(sql)) {
      // Fire-and-forget target write with error boundary
      this.target.query(sql, params).catch((err) => {
        console.error('[dual-write] target write failed:', err.message);
      });
    }

    if (this.isShadowReadCandidate(sql)) {
      this.executeShadowRead(sql, params, primaryResult.rows);
    }

    return primaryResult.rows;
  }

  private isWriteOperation(sql: string): boolean {
    return /^\s*(INSERT|UPDATE|DELETE|UPSERT)/i.test(sql);
  }

  private isShadowReadCandidate(sql: string): boolean {
    return (
      /^\s*SELECT/i.test(sql) &&
      Math.random() * 100 < this.config.shadowReadPercent
    );
  }

  private executeShadowRead(
    sql: string,
    params: unknown[],
    primaryRows: unknown[]
  ): void {
    this.target
      .query(sql, params)
      .then((result) => {
        if (JSON.stringify(result.rows) !== JSON.stringify(primaryRows)) {
          console.warn('[shadow-read] discrepancy detected', { sql, params });
        }
      })
      .catch((err) => {
        console.error('[shadow-read] target query failed:', err.message);
      });
  }
}
```

---

## Rollout Sequence

### Phase 1 — Dual-Write

**Goal:** Both schemas receive every write. Primary remains authoritative.

1. Deploy the Abstraction Layer with `dualWriteEnabled: true`, `shadowReadPercent: 0`.
2. Monitor target write error rates. Expect a brief spike as new schema constraints are validated.
3. Run for at least one full traffic cycle (24–48 hours) before proceeding.

**Rollback:** Set `dualWriteEnabled: false`. No schema changes needed.

---

### Phase 2 — Backfill

**Goal:** Migrate all existing rows from the old schema to the new schema.

1. Run the backfill job in small batches (e.g., 1,000 rows/second) to avoid locking or replication lag.
2. Use a `migrated_at` timestamp column or a separate tracking table to checkpoint progress.
3. Dual-write must remain active during backfill so new writes don't create gaps.

```sql
-- Example backfill cursor pattern
INSERT INTO new_schema.users (id, email, created_at)
SELECT id, email, created_at
FROM old_schema.users
WHERE id > $1
ORDER BY id
LIMIT 1000
ON CONFLICT (id) DO NOTHING;
```

**Rollback:** Truncate the new schema table and restart. No production impact.

---

### Phase 3 — Shadow Reads

**Goal:** Validate query correctness and performance on the new schema at production scale.

1. Set `shadowReadPercent: 1`. Watch logs for discrepancies and slow queries.
2. Ramp to `10`, then `50`, then `100` over several days.
3. At 100% shadow reads with zero discrepancies, you have high confidence the new schema is correct.

**Rollback:** Set `shadowReadPercent: 0`. No schema changes needed.

---

### Phase 4 — Cutover

**Goal:** Flip the primary to the new schema.

1. With shadow reads at 100% and zero discrepancies, update the Abstraction Layer to treat the **target** as primary.
2. Keep the old schema alive (read-only) for 24–48 hours as a hot rollback option.
3. Once satisfied, disable dual-write and drop the old schema.

```
config change:  primary ⟷ target  (swap)
old schema:     set read-only
monitor:        24–48 hours
cleanup:        drop old schema, remove abstraction layer
```

**Rollback:** Swap primary/target back in config. Old schema is still intact.

---

## Project Structure

```
zero-downtime-postgres-migration/
├── src/
│   └── dual-write-middleware.ts   # Core middleware implementation
├── package.json
└── README.md
```

---

## Getting Started

```bash
npm install
npx tsc
```

Configure your database connections in `src/dual-write-middleware.ts` and wire the middleware into your existing query layer.

---

## Further Reading

Full architectural breakdown, production incident post-mortem, and extended code examples:

**[ctousman.com/blog/zero-downtime-database-migration-engine](https://ctousman.com/blog/zero-downtime-database-migration-engine)**
