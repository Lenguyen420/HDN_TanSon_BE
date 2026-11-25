import { Router } from "express";
import { z } from "zod";
import {
  dailyQuery,
  dayDetailQuery,
  financeDate,
  financePage,
  idempotencyKey,
  newEntryBody,
  openingBody,
  patchEntryBody,
  previewBody,
  rangeQuery,
  reverseBody,
  sponsorshipBody,
  voidBody,
} from "../dto/finance.dto.js";
import { idSchema } from "../dto/member.dto.js";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { financeError } from "../services/financeShared.js";
import { receiveSponsorship } from "../services/financeSources.js";
import { financeWorkbook } from "../services/financeWorkbook.js";

function financeManager(req, res, next) {
  if (req.user.role !== "SUPER_ADMIN")
    throw financeError(
      403,
      "FINANCE_FORBIDDEN",
      "Thao tác cần quyền quản trị viên cấp cao.",
    );
  next();
}

const paramId = (req) => idSchema.parse(req.params.id);
const date = (req) => financeDate.parse(req.params.date);
const key = (req) => {
  const result = idempotencyKey.safeParse(req.get("Idempotency-Key"));
  if (!result.success)
    throw financeError(
      400,
      "FINANCE_INVALID_IDEMPOTENCY_KEY",
      "Yêu cầu Idempotency-Key hợp lệ.",
    );
  return result.data;
};
const pagination = z.strictObject(financePage);

export default function financeRouter(services) {
  const router = Router();
  const finance = services.finance;
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  }, authAdmin(services.auth));

  router.get("/settings", async (req, res) =>
    res.json(await finance.getSettings()),
  );
  router.post(
    "/settings/opening",
    financeManager,
    validateBody(openingBody),
    async (req, res) =>
      res.status(201).json(await finance.open(req.body, req.user.id)),
  );
  router.get("/summary", validateQuery(rangeQuery), async (req, res) =>
    res.json(await finance.reports.summary(res.locals.query)),
  );
  router.get("/daily", validateQuery(dailyQuery), async (req, res) =>
    res.json(await finance.reports.daily(res.locals.query)),
  );
  router.get("/daily/:date", validateQuery(dayDetailQuery), async (req, res) =>
    res.json(await finance.reports.day(date(req), res.locals.query)),
  );
  router.post("/daily/:date/close", financeManager, async (req, res) => {
    z.strictObject({}).parse(req.body ?? {});
    res.json(await finance.close(date(req), req.user.id));
  });
  router.post(
    "/transactions/preview",
    validateBody(previewBody),
    async (req, res) => res.json(await finance.preview(req.body)),
  );
  router.post("/transactions", validateBody(newEntryBody), async (req, res) =>
    res.status(201).json(await finance.create(req.body, req.user.id, key(req))),
  );
  router.patch(
    "/transactions/:id",
    validateBody(patchEntryBody),
    async (req, res) =>
      res.json(await finance.update(paramId(req), req.body, req.user.id)),
  );
  router.post(
    "/transactions/:id/void",
    validateBody(voidBody),
    async (req, res) =>
      res.json(await finance.void(paramId(req), req.body, req.user.id)),
  );
  router.post(
    "/transactions/:id/reverse",
    validateBody(reverseBody),
    async (req, res) =>
      res
        .status(201)
        .json(
          await finance.reverse(paramId(req), req.body, req.user, key(req)),
        ),
  );
  router.get(
    "/transactions/:id/audit",
    validateQuery(pagination),
    async (req, res) =>
      res.json(await finance.history(paramId(req), res.locals.query)),
  );
  router.get("/transactions/:id/attachments/:fileId", async (req, res) => {
    const file = await finance.attachment(
      paramId(req),
      idSchema.parse(req.params.fileId),
    );
    res
      .set({
        "Content-Type": file.type,
        "Content-Length": String(file.size),
        "Content-Disposition":
          "attachment; filename*=UTF-8''" +
          encodeURIComponent(file.name).replace(/'/g, "%27"),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      })
      .send(file.bytes);
  });
  router.post(
    "/sponsorships/:id/receive",
    financeManager,
    validateBody(sponsorshipBody),
    async (req, res) =>
      res
        .status(201)
        .json(
          await receiveSponsorship(
            finance,
            paramId(req),
            req.body,
            req.user.id,
            key(req),
          ),
        ),
  );
  router.get("/pending-receipts", validateQuery(pagination), async (req, res) =>
    res.json(await finance.pendingReceipts(res.locals.query)),
  );
  router.get("/export", validateQuery(rangeQuery), async (req, res) => {
    const report = await finance.reports.export(res.locals.query);
    const workbook = financeWorkbook(report);
    if (workbook.length > 4 * 1024 * 1024)
      throw financeError(
        422,
        "FINANCE_EXPORT_LIMIT",
        "Tệp vượt 4 MiB. Hãy chọn khoảng ngày ngắn hơn.",
      );
    res
      .set({
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="thu-chi-${report.from}-${report.to}.xlsx"`,
        "Access-Control-Expose-Headers": "Content-Disposition",
      })
      .send(workbook);
  });
  return router;
}
