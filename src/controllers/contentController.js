export default function contentController(service, isPublic = false) {
  return {
    list: async (req, res) =>
      res.json(await service.list(res.locals.query, isPublic)),
    get: async (req, res) =>
      res.json({ data: await service.get(req.params.id, isPublic) }),
    create: async (req, res) =>
      res.status(201).json(await service.create(req.body)),
    update: async (req, res) =>
      res.json(await service.update(req.params.id, req.body)),
    remove: async (req, res) => res.json(await service.remove(req.params.id)),
  };
}
