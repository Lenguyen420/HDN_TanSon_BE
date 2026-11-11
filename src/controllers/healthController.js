export default function healthController(req, res) {
  const connected = req.app.locals.db.readyState === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? "ok" : "unavailable",
    service: "tanson-backend",
  });
}
