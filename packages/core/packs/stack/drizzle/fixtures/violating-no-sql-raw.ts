import { sql } from "drizzle-orm";
const w = sql.raw("id = " + id);
