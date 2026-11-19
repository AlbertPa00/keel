// application service importing an adapter directly — must fail
import { PostgresUserRepo } from "../../adapters/out/postgres-user-repo.js";

export async function getUser(id: string) {
  const repo = new PostgresUserRepo();
  return repo.find(id);
}
