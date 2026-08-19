import { createDbClient } from "@honeypot/db";
import { config } from "./config.js";

export const { db, client } = createDbClient({ connectionString: config.databaseUrl, max: 10 });
