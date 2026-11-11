export const validateBody = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
    next();
  } catch (error) {
    next(error);
  }
};
export const validateQuery = (schema) => (req, res, next) => {
  try {
    res.locals.query = schema.parse(req.query);
    next();
  } catch (error) {
    next(error);
  }
};
