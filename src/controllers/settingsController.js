export default function settingsController(settings) {
  return {
    get: async (req, res) => res.json(await settings.get()),
    getPublic: async (req, res) => res.json(await settings.get(true)),
    update: async (req, res) =>
      res.json(await settings.update(req.body, req.user.id)),
  };
}
