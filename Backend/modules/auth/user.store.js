import fs from "node:fs";
import path from "node:path";
import Datastore from "nedb-promises";

const DATA_DIR = path.resolve(process.cwd(), "data");
const USERS_DB_PATH = path.join(DATA_DIR, "users.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const usersDb = Datastore.create({
  filename: USERS_DB_PATH,
  autoload: true,
  timestampData: true,
});

await usersDb.ensureIndex({ fieldName: "email", unique: true });
await usersDb.ensureIndex({ fieldName: "identity", unique: true });
