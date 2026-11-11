import { Schema } from "mongoose";
import { defaultSettings } from "../dto/settings.dto.js";

export default function createModel(connection) {
  const schema = new Schema(
    {
      _id: { type: String, enum: ["association"], required: true },
      ...Object.fromEntries(
        Object.entries(defaultSettings).map(([key, value]) => [
          key,
          { type: String, default: value },
        ]),
      ),
      updatedBy: { type: String, default: null },
    },
    { collection: "association_settings", timestamps: true, versionKey: false },
  );
  return connection.model("AssociationSettings", schema);
}
