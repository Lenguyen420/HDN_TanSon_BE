export default function registrationController(registrations) {
  return {
    list: async (req, res) =>
      res.json(await registrations.list(res.locals.query)),
    get: async (req, res) => res.json(await registrations.get(req.params.id)),
    create: async (req, res) =>
      res.status(201).json(await registrations.create(req.body)),
    update: async (req, res) =>
      res.json(await registrations.update(req.params.id, req.body)),
    remove: async (req, res) =>
      res.json(await registrations.remove(req.params.id)),
    approve: async (req, res) =>
      res.json(await registrations.approve(req.params.id, req.user.id)),
    reject: async (req, res) =>
      res.json(
        await registrations.reject(req.params.id, req.user.id, req.body.reason),
      ),
    import: async (req, res) =>
      res
        .status(201)
        .json(await registrations.import(req.body.registrations, req.user.id)),
    submitPublic: async (req, res) =>
      res.status(201).json(await registrations.submitPublic(req.body)),
  };
}
