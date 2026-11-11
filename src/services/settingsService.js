import { defaultSettings } from "../dto/settings.dto.js";

function present(row, isPublic = false) {
  const data = { id: "association" };
  for (const key of Object.keys(defaultSettings))
    data[key] = row?.[key] ?? defaultSettings[key];
  if (!isPublic) {
    data.updatedAt = row?.updatedAt ?? null;
    data.updatedBy = row?.updatedBy ?? null;
  }
  return data;
}

export class SettingsService {
  constructor(settings) {
    this.settings = settings;
  }

  async get(isPublic = false) {
    const row = await this.settings.findById("association").lean();
    return { data: present(row, isPublic) };
  }

  async update(dto, adminId) {
    const { id, ...fields } = dto;
    const update = { $set: { ...fields, updatedBy: adminId } };
    let row;
    try {
      row = await this.settings
        .findOneAndUpdate({ _id: "association" }, update, {
          new: true,
          upsert: true,
          runValidators: true,
        })
        .lean();
    } catch (error) {
      // Two first-time saves may race on the singleton's unique _id.
      if (error.code !== 11000) throw error;
      row = await this.settings
        .findOneAndUpdate({ _id: "association" }, update, {
          new: true,
          runValidators: true,
        })
        .lean();
    }
    return { data: present(row) };
  }
}
