import type Database from "better-sqlite3";
import type { SaveFailure } from "./published-state-repository.js";

/** Shared Connection gate only. Attempts/evidence remain Repository-specific. */
export interface ConnectionCoordination {
  busy: boolean;
  connectionUnresolved: boolean;
  blocked?: SaveFailure;
}
const connections = new WeakMap<Database.Database, ConnectionCoordination>();
export function connectionCoordination(
  db: Database.Database,
): ConnectionCoordination {
  let state = connections.get(db);
  if (!state) {
    state = { busy: false, connectionUnresolved: false };
    connections.set(db, state);
  }
  return state;
}
