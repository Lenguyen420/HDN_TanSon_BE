import { Schema } from "mongoose";

export default function createZaloOAuthModels(connection) {
  const flow = new Schema({
    _id: String,
    browserHash: { type: String, required: true },
    verifier: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  });
  flow.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const session = new Schema({
    _id: String,
    encryptedToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  });
  session.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return {
    flows: connection.model("ZaloOAuthFlow", flow, "zalo_oauth_flows"),
    sessions: connection.model(
      "ZaloOAuthSession",
      session,
      "zalo_oauth_sessions",
    ),
  };
}
