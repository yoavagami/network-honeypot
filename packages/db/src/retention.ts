import postgres from "postgres";

/**
 * Retention/redaction + partition maintenance — see docs/DATA_MODEL.md §3/§4. Runs as the
 * Postgres superuser (same connection as migrate.ts), never as honeypot_role: creating/dropping
 * partitions is DDL, and NULL-ing ip_raw across the whole partitioned table is broader UPDATE
 * access than honeypot_role is deliberately granted (see 0001_init.sql's GRANT block — the app
 * only gets INSERT on requests, not UPDATE). Keeping this out-of-process, run on a schedule
 * instead of in the app's event loop, matches that same least-privilege boundary.
 */

const RAW_IP_RETENTION_DAYS = Number(process.env.RAW_IP_RETENTION_DAYS ?? 7);
const EVENT_RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS ?? 90);
// Matches migrate.ts's own -1..+2 month window — keeps at least this many months of partitions
// pre-created ahead of `now` so inserts never hit "no partition of relation found for row".
const FUTURE_PARTITION_MONTHS = 2;

const PARTITIONED_TABLES = ["requests", "events"] as const;
const PARTITION_NAME_RE = /^(requests|events)_(\d{4})_(\d{2})$/;

async function redactOldRawIps(sql: postgres.Sql) {
  const result = await sql`
    UPDATE requests SET ip_raw = NULL
    WHERE ip_raw IS NOT NULL AND created_at < now() - make_interval(days => ${RAW_IP_RETENTION_DAYS})
  `;
  return result.count;
}

async function ensureFuturePartitions(sql: postgres.Sql) {
  const created: string[] = [];
  for (let i = 0; i <= FUTURE_PARTITION_MONTHS; i++) {
    // Select dates as pre-formatted text, not the `date` SQL type — postgres.js parses `date`
    // columns into JS Date objects, and interpolating one into sql.unsafe() via template-literal
    // toString() produces a locale-formatted string like "Tue Oct 01 2026 GMT+0200 (...)", which
    // Postgres then rejects as an invalid timestamp literal.
    const rows = await sql<{ start_date: string; end_date: string; suffix: string }[]>`
      SELECT
        to_char(date_trunc('month', now() + (${i} || ' month')::interval), 'YYYY-MM-DD') AS start_date,
        to_char(date_trunc('month', now() + (${i} || ' month')::interval) + interval '1 month', 'YYYY-MM-DD') AS end_date,
        to_char(date_trunc('month', now() + (${i} || ' month')::interval), 'YYYY_MM') AS suffix
    `;
    const { start_date, end_date, suffix } = rows[0]!;
    for (const table of PARTITIONED_TABLES) {
      const partitionName = `${table}_${suffix}`;
      const exists = await sql`SELECT 1 FROM pg_class WHERE relname = ${partitionName}`;
      if (exists.length > 0) continue;
      await sql.unsafe(
        `CREATE TABLE ${partitionName} PARTITION OF ${table} FOR VALUES FROM ('${start_date}') TO ('${end_date}')`
      );
      created.push(partitionName);
    }
  }
  return created;
}

async function dropExpiredPartitions(sql: postgres.Sql) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - EVENT_RETENTION_DAYS);

  const partitions = await sql<{ partition_name: string }[]>`
    SELECT child.relname AS partition_name
    FROM pg_inherits
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    WHERE parent.relname IN ('requests', 'events')
  `;

  const dropped: string[] = [];
  for (const { partition_name } of partitions) {
    const match = PARTITION_NAME_RE.exec(partition_name);
    if (!match) continue; // not one of our generated monthly partitions — leave it alone
    const [, , year, month] = match;
    // Partition covers [start, start+1month) — it's fully expired once that end date is in the past.
    const partitionEnd = new Date(Date.UTC(Number(year), Number(month), 1));
    if (partitionEnd > cutoff) continue;
    await sql.unsafe(`DROP TABLE IF EXISTS ${partition_name}`);
    dropped.push(partition_name);
  }
  return dropped;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to run retention");

  const sql = postgres(connectionString, { max: 1 });
  try {
    const redactedRows = await redactOldRawIps(sql);
    const createdPartitions = await ensureFuturePartitions(sql);
    const droppedPartitions = await dropExpiredPartitions(sql);
    console.log(
      JSON.stringify(
        {
          rawIpRetentionDays: RAW_IP_RETENTION_DAYS,
          eventRetentionDays: EVENT_RETENTION_DAYS,
          redactedRows,
          createdPartitions,
          droppedPartitions,
        },
        null,
        2
      )
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
