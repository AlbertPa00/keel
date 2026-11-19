// application depending on a port it owns — passes
import type { User } from "../domain/user.js";

export interface UserRepo {
  find(id: string): Promise<User | null>;
}

export async function getUser(repo: UserRepo, id: string) {
  return repo.find(id);
}
