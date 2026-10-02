import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { db, rolesTable, storesTable, usersTable } from "@workspace/db";

export type UserRole = "CUSTOMER" | "STORE" | "ADMIN";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  storeId: string | null;
  storeName: string | null;
};

declare global {
  namespace Express {
    interface Request {
      authUser?: SessionUser;
    }
  }
}

const cookieName = "nova_session";
const sessionTtlSeconds = 8 * 60 * 60;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required for NOVA PULSE sessions.");
  return value;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `${salt}.${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(".");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBytes = Buffer.from(expected, "base64url");
  return (
    actual.length === expectedBytes.length &&
    timingSafeEqual(actual, expectedBytes)
  );
}

export function createSessionToken(user: Pick<SessionUser, "id" | "role">): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: user.id,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + sessionTtlSeconds,
  });
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret()).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function verifySessionToken(token: string): { sub: string } | null {
  try {
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return null;
    const data = `${header}.${payload}`;
    const expected = createHmac("sha256", secret()).update(data).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return null;
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (
      typeof claims.sub !== "string" ||
      typeof claims.exp !== "number" ||
      claims.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return { sub: claims.sub };
  } catch {
    return null;
  }
}

export async function findSessionUserByEmail(email: string): Promise<{
  user: SessionUser;
  passwordHash: string;
} | null> {
  const [row] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      role: rolesTable.id,
      storeId: usersTable.storeId,
      storeName: storesTable.name,
      passwordHash: usersTable.passwordHash,
    })
    .from(usersTable)
    .innerJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
    .leftJoin(storesTable, eq(usersTable.storeId, storesTable.id))
    .where(eq(usersTable.email, email.toLowerCase()));
  if (!row) return null;
  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as UserRole,
      storeId: row.storeId,
      storeName: row.storeName,
    },
    passwordHash: row.passwordHash,
  };
}

export async function findSessionUserById(id: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      role: rolesTable.id,
      storeId: usersTable.storeId,
      storeName: storesTable.name,
    })
    .from(usersTable)
    .innerJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
    .leftJoin(storesTable, eq(usersTable.storeId, storesTable.id))
    .where(eq(usersTable.id, id));
  if (!row) return null;
  return {
    ...row,
    role: row.role as UserRole,
  };
}

export const requireAuth: RequestHandler = async (req, res, next): Promise<void> => {
  const bearer = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = req.cookies?.[cookieName] ?? bearer;
  if (typeof token !== "string") {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  const claims = verifySessionToken(token);
  if (!claims) {
    res.status(401).json({ error: "Your session has expired. Sign in again." });
    return;
  }
  try {
    const user = await findSessionUserById(claims.sub);
    if (!user) {
      res.status(401).json({ error: "This account is no longer available." });
      return;
    }
    req.authUser = user;
    next();
  } catch (error) {
    req.log.error({ err: error }, "Could not validate session");
    res.status(500).json({ error: "We could not validate your session right now." });
  }
};

export function requireRole(...allowed: UserRole[]): RequestHandler {
  return (req, res, next): void => {
    if (!req.authUser) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    if (!allowed.includes(req.authUser.role)) {
      res.status(403).json({ error: "This area is not available to your account." });
      return;
    }
    next();
  };
}

export function setSessionCookie(res: Parameters<RequestHandler>[1], token: string): void {
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: sessionTtlSeconds * 1000,
    path: "/api",
  });
}

export function clearSessionCookie(res: Parameters<RequestHandler>[1]): void {
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api",
  });
}