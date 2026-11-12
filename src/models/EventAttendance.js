import { Schema } from "mongoose";
export default function createEventAttendanceModel(connection) {
  const schema = new Schema(
    {
      _id: { type: String, required: true },
      eventId: { type: String, required: true },
      tokenHash: { type: String, required: true },
      name: { type: String, required: true, maxlength: 150 },
      company: { type: String, default: "", maxlength: 250 },
      checkedAt: { type: Date, required: true },
    },
    { collection: "event_attendance", versionKey: false },
  );
  schema.index({ eventId: 1, tokenHash: 1 }, { unique: true });
  schema.index({ eventId: 1, checkedAt: -1 });
  return connection.model("EventAttendance", schema);
}
