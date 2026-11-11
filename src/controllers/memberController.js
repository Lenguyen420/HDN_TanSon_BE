export default function memberController(members) {
  return {
    list: async (req, res) => res.json(await members.list(res.locals.query)),
    get: async (req, res) =>
      res.json({ data: await members.get(req.params.id) }),
    create: async (req, res) =>
      res.status(201).json(await members.create(req.body)),
    update: async (req, res) =>
      res.json(await members.update(req.params.id, req.body)),
    remove: async (req, res) => res.json(await members.remove(req.params.id)),
    import: async (req, res) =>
      res.status(201).json(await members.import(req.body.members)),
  };
}
