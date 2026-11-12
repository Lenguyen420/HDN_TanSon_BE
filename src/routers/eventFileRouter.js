import { Router, raw } from "express";
import authAdmin from "../middlewares/authAdmin.js";
import { maxEventFileSize } from "../services/eventFileService.js";
export default function eventFileRouter(services) {
  const router = Router();
  router.post(
    "/admin/event-files",
    authAdmin(services.auth),
    raw({ type: "application/octet-stream", limit: maxEventFileSize }),
    async (req, res) => {
      const result = await services.eventFiles.upload(
        req.body,
        req.get("x-file-name") || "",
        req.user.id,
      );
      res.status(201).json(result);
    },
  );
  router.get("/public/event-files/:id", async (req, res) => {
    await services.eventFiles.serve(req.params.id, req, res);
  });
  return router;
}
