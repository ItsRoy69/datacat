import app from "./app";
import { logger } from "./lib/logger";
import { startMonitorLoop, startRetentionLoop } from "./jobs/monitors";
import { migrateDatabase, buildBackgroundIndexes } from "./lib/migrate";
import { storage, useClickHouse } from "./lib/storage";
import { ensureChSchema } from "./lib/ch";
import { pool } from "@workspace/db";
import { generatedSetupToken } from "./routes/auth";

const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

await migrateDatabase();
if (useClickHouse) await ensureChSchema();
logger.info({ storage }, "telemetry storage");
if (generatedSetupToken && !(await pool.query("select 1 from users limit 1")).rowCount) {
  logger.warn(`First-run setup token (enter it on the setup page): ${generatedSetupToken}`);
}
app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  // Run several API processes against one database by giving all but one DATACAT_BACKGROUND_JOBS=false, so monitors
  // are evaluated (and notifications sent) by exactly one process.
  if (String(process.env.DATACAT_BACKGROUND_JOBS ?? "true").toLowerCase() !== "false") {
    startMonitorLoop();
    startRetentionLoop();
    void buildBackgroundIndexes((msg, extra) => logger.info(extra ?? {}, msg));
  } else logger.info("background jobs disabled (DATACAT_BACKGROUND_JOBS=false)");
});
