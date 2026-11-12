export class ZaloSdkProfileService {
  constructor(profiles) {
    this.profiles = profiles;
  }
  async save({ zaloUserId, name, avatar }) {
    const update = { $set: { name, avatar, consentReportedAt: new Date() } };
    let profile;
    try {
      profile = await this.profiles
        .findOneAndUpdate({ _id: zaloUserId }, update, {
          upsert: true,
          new: true,
          runValidators: true,
        })
        .lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      profile = await this.profiles
        .findOneAndUpdate({ _id: zaloUserId }, update, {
          new: true,
          runValidators: true,
        })
        .lean();
    }
    return {
      zaloUserId: profile._id,
      verificationStatus: "unverified",
      linked: false,
      member: null,
      user: {
        id: profile._id,
        name: profile.name,
        avatar: profile.avatar,
        phone: null,
      },
    };
  }
}
