// application importing inward — passes the boundary check
import type { Order } from "../domain/order.js";

export interface OrderRepo {
  save(order: Order): Promise<void>;
}

export async function placeOrder(repo: OrderRepo, order: Order) {
  await repo.save(order);
}
