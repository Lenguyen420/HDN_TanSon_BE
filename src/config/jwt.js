import jwt from "jsonwebtoken";
export function createTokenService(secret) {
  return {
    signAsync: async (payload, options) =>
      jwt.sign(payload, secret, { ...options, algorithm: "HS256" }),
    verifyAsync: async (token, options) =>
      jwt.verify(token, secret, { ...options, algorithms: ["HS256"] }),
  };
}
