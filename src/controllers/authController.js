export default function authController(auth) {
  return {
    login: async (req, res) =>
      res.json({
        data: await auth.login(req.body.username, req.body.password),
      }),
    refresh: async (req, res) =>
      res.json({ data: await auth.refresh(req.body.refreshToken) }),
    logout: async (req, res) =>
      res.json(await auth.logout(req.body.refreshToken)),
    me: (req, res) => res.json({ data: req.user }),
  };
}
