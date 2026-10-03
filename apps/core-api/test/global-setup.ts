import { migrateTestDatabase } from './database.ts';

/** Runs once before the suite, so every test file starts on the real schema. */
export default async function setup(): Promise<void> {
  await migrateTestDatabase();
}
