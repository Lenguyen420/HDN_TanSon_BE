import { Schema } from "mongoose";
export const SessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "auth_sessions" },
);
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default function createModel(connection) {
  return connection.model("AuthSession", SessionSchema);
}
