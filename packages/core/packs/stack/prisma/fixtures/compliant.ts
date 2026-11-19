import { db } from "./db";
export const users = () => db.user.findMany();
