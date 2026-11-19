// domain importing outward — must fail the boundary check
import { prisma } from "../../adapters/db/client.js";
import type { Order } from "./order.js";

export function saveOrder(order: Order) {
  return prisma.order.create({ data: order });
}
