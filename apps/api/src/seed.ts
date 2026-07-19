import { nanoid } from "nanoid";
import { db, migrate } from "./db.js";

migrate();

const codes = ["BAY-FRIENDS", "BAY-DEMO", nanoid(8).toUpperCase()];
const insert = db.prepare(
  `INSERT OR IGNORE INTO invites (code, created_at) VALUES (?, ?)`
);
const now = new Date().toISOString();
for (const code of codes) {
  insert.run(code, now);
}

console.log("Seeded invite codes:");
for (const code of codes) console.log(`  ${code}`);
console.log("\nUse BAY-FRIENDS or BAY-DEMO to sign up.");
