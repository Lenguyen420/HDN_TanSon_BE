import { loadEnvironment } from "../src/config/environment.js";
import connectDB from "../src/config/database.js";
import { seedTradeCategories } from "../src/services/tradeCategorySeed.js";

const connection = await connectDB(loadEnvironment().get("MONGODB_URI"));
try {
  const result = await seedTradeCategories(
    connection.db.collection("trade_categories"),
  );
  console.log(
    `Danh mục giao thương: thêm ${result.added}, đã có ${result.existing}.`,
  );
} finally {
  await connection.close();
}
