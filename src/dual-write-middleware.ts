import { Pool, QueryResult } from 'pg';

export interface DualWriteConfig {
  dualWriteEnabled: boolean;
  shadowReadPercent: number; // 0–100
}

export interface MigrationLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: MigrationLogger = {
  warn: (message, context) => console.warn(`[dual-write-middleware] ${message}`, context ?? ''),
  error: (message, context) => console.error(`[dual-write-middleware] ${message}`, context ?? ''),
};

/**
 * DualWriteMiddleware sits between application code and PostgreSQL.
 *
 * - Write operations are sent to primary (authoritative) and optionally
 *   replicated to the target schema with a non-fatal error boundary.
 * - Read operations are optionally shadowed to the target at a configurable
 *   percentage; the primary result is always returned to the caller.
 *
 * See: https://ctousman.com/blog/zero-downtime-database-migration-engine
 */
export class DualWriteMiddleware {
  private readonly logger: MigrationLogger;

  constructor(
    private readonly primary: Pool,
    private readonly target: Pool,
    private config: DualWriteConfig,
    logger?: MigrationLogger
  ) {
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Execute a query against the primary database.
   * Dual-write and shadow-read behaviour is applied automatically based on config.
   */
  async query<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const primaryResult: QueryResult<T> = await this.primary.query<T>(sql, params);

    if (this.config.dualWriteEnabled && this.isWriteOperation(sql)) {
      this.replicateWrite(sql, params);
    }

    if (this.isShadowReadCandidate(sql)) {
      this.executeShadowRead<T>(sql, params, primaryResult.rows);
    }

    return primaryResult.rows;
  }

  /** Update runtime configuration without redeployment. */
  updateConfig(patch: Partial<DualWriteConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** Close both connection pools. */
  async close(): Promise<void> {
    await Promise.allSettled([this.primary.end(), this.target.end()]);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isWriteOperation(sql: string): boolean {
    return /^\s*(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i.test(sql.trimStart());
  }

  private isShadowReadCandidate(sql: string): boolean {
    return (
      /^\s*SELECT\b/i.test(sql.trimStart()) &&
      this.config.shadowReadPercent > 0 &&
      Math.random() * 100 < this.config.shadowReadPercent
    );
  }

  /**
   * Fire-and-forget target write.
   * Errors are caught and logged — they must never surface to the caller.
   */
  private replicateWrite(sql: string, params: unknown[]): void {
    this.target.query(sql, params).catch((err: Error) => {
      this.logger.error('target write failed', {
        message: err.message,
        sql: this.redact(sql),
      });
    });
  }

  /**
   * Execute the same read against the target schema and compare results.
   * The comparison is purely diagnostic — divergence is logged, never thrown.
   */
  private executeShadowRead<T extends object>(
    sql: string,
    params: unknown[],
    primaryRows: T[]
  ): void {
    this.target
      .query<T>(sql, params)
      .then((result) => {
        if (!this.rowsAreEqual(primaryRows, result.rows)) {
          this.logger.warn('shadow read discrepancy detected', {
            sql: this.redact(sql),
            primaryCount: primaryRows.length,
            targetCount: result.rows.length,
          });
        }
      })
      .catch((err: Error) => {
        this.logger.error('shadow read failed', {
          message: err.message,
          sql: this.redact(sql),
        });
      });
  }

  private rowsAreEqual<T>(a: T[], b: T[]): boolean {
    // Stable JSON comparison — sufficient for most scalar schemas.
    // For complex types (JSONB arrays, custom ordering) inject a custom comparator.
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /** Truncate long SQL for safe logging. */
  private redact(sql: string): string {
    return sql.length > 200 ? `${sql.slice(0, 200)}…` : sql;
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a DualWriteMiddleware from plain connection strings.
 *
 * Example:
 *   const db = createMigrationMiddleware(
 *     process.env.PRIMARY_DATABASE_URL!,
 *     process.env.TARGET_DATABASE_URL!,
 *     { dualWriteEnabled: true, shadowReadPercent: 10 }
 *   );
 */
export function createMigrationMiddleware(
  primaryConnectionString: string,
  targetConnectionString: string,
  config: DualWriteConfig,
  logger?: MigrationLogger
): DualWriteMiddleware {
  const primary = new Pool({ connectionString: primaryConnectionString });
  const target = new Pool({ connectionString: targetConnectionString });
  return new DualWriteMiddleware(primary, target, config, logger);
}
