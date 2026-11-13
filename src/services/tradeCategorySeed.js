import { randomUUID } from "node:crypto";

export const defaultTradeCategories = [
  { code: "PRODUCTS", name: "Sản phẩm" },
  { code: "SERVICES", name: "Dịch vụ" },
  { code: "BUY", name: "Cần mua" },
  { code: "PROMOTION", name: "Khuyến mãi", requiresPromotionDetails: true },
  { code: "COMMUNITY", name: "Cộng đồng" },
];

// Only insert absent codes. Never reactivate or replace categories managed by admin.
export async function seedTradeCategories(collection) {
  const now = new Date();
  const result = await collection.bulkWrite(
    defaultTradeCategories.map((category, sortOrder) => ({
      updateOne: {
        filter: { code: category.code },
        update: {
          $setOnInsert: {
            _id: randomUUID(),
            ...category,
            sortOrder,
            isActive: true,
            requiresPromotionDetails:
              category.requiresPromotionDetails || false,
            version: 1,
            createdById: "system",
            updatedById: "system",
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    })),
  );
  return {
    added: result.upsertedCount,
    existing: defaultTradeCategories.length - result.upsertedCount,
  };
}
