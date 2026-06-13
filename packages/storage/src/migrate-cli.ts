import { createPool } from "./db.js";
import { migrate } from "./migrate.js";

const pool = createPool();
const applied = await migrate(pool);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
await pool.end();
