import { Router, type IRouter } from "express";
import {
  GetCurrentUserResponse,
  LoginBody,
  LoginResponse,
  LogoutResponse,
} from "@workspace/api-zod";
import {
  clearSessionCookie,
  createSessionToken,
  findSessionUserByEmail,
  findSessionUserById,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from "../lib/auth";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid email and password." });
    return;
  }
  const login = await findSessionUserByEmail(parsed.data.email);
  if (!login || !verifyPassword(parsed.data.password, login.passwordHash)) {
    res.status(401).json({ error: "Email or password was not recognized." });
    return;
  }
  const token = createSessionToken(login.user);
  setSessionCookie(res, token);
  res.json(LoginResponse.parse({ user: login.user }));
});

router.post("/auth/logout", (_req, res): void => {
  clearSessionCookie(res);
  res.json(LogoutResponse.parse({ message: "Signed out." }));
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const user = await findSessionUserById(req.authUser!.id);
  if (!user) {
    res.status(401).json({ error: "This account is no longer available." });
    return;
  }
  res.json(GetCurrentUserResponse.parse(user));
});

export default router;