import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { usersDb } from "./user.store.js";

const AUTH_JWT_EXPIRES_IN = process.env.AUTH_JWT_EXPIRES_IN || "8h";

function sanitizeIdentity(rawValue) {
  const value = rawValue?.toString().trim().toLowerCase() || "";
  return value.replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
}

function normalizeEmail(rawValue) {
  return rawValue?.toString().trim().toLowerCase() || "";
}

function normalizeName(rawValue) {
  return rawValue?.toString().trim() || "";
}

function generateIdentityFromInput({ email, name }) {
  const emailLocalPart = normalizeEmail(email).split("@")[0] || "";
  const namePart = normalizeName(name).toLowerCase().replace(/\s+/g, ".");
  const candidate = sanitizeIdentity(namePart || emailLocalPart || "user");
  return candidate || "user";
}

async function resolveUniqueIdentity(baseIdentity) {
  const seed = sanitizeIdentity(baseIdentity) || "user";
  let candidate = seed;
  let suffix = 0;

  while (true) {
    const exists = await usersDb.findOne({ identity: candidate });
    if (!exists) {
      return candidate;
    }

    suffix += 1;
    candidate = `${seed}${suffix}`.slice(0, 40);
  }
}

function requireAuthSecret() {
  const secret = process.env.JWT_SECRET?.toString().trim();
  if (!secret) {
    throw new Error("JWT_SECRET is required for auth");
  }
  return secret;
}

function signAuthToken(user) {
  const secret = requireAuthSecret();

  return jwt.sign(
    {
      sub: user._id,
      email: user.email,
      identity: user.identity,
      twilio_identity: user.identity,
      role: user.role || "user",
    },
    secret,
    {
      algorithm: "HS256",
      expiresIn: AUTH_JWT_EXPIRES_IN,
    }
  );
}

function toPublicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    identity: user.identity,
    role: user.role || "user",
    createdAt: user.createdAt,
  };
}

export async function registerUser({ name, email, password, identity }) {
  const normalizedName = normalizeName(name);
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = password?.toString() || "";

  if (!normalizedName) {
    return { ok: false, status: 400, error: "Name is required" };
  }

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return { ok: false, status: 400, error: "Valid email is required" };
  }

  if (normalizedPassword.length < 8) {
    return { ok: false, status: 400, error: "Password must be at least 8 characters" };
  }

  const existingUser = await usersDb.findOne({ email: normalizedEmail });
  if (existingUser) {
    return { ok: false, status: 409, error: "Email already registered" };
  }

  const requestedIdentity = sanitizeIdentity(identity || "");
  const identitySeed = requestedIdentity || generateIdentityFromInput({ email: normalizedEmail, name: normalizedName });
  const uniqueIdentity = await resolveUniqueIdentity(identitySeed);

  const passwordHash = await bcrypt.hash(normalizedPassword, 10);

  const createdUser = await usersDb.insert({
    name: normalizedName,
    email: normalizedEmail,
    identity: uniqueIdentity,
    passwordHash,
    role: "user",
    isActive: true,
  });

  const token = signAuthToken(createdUser);
  return {
    ok: true,
    status: 201,
    token,
    user: toPublicUser(createdUser),
  };
}

export async function loginUser({ email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const rawPassword = password?.toString() || "";

  if (!normalizedEmail || !rawPassword) {
    return { ok: false, status: 400, error: "Email and password are required" };
  }

  const user = await usersDb.findOne({ email: normalizedEmail });
  if (!user || !user.isActive) {
    return { ok: false, status: 401, error: "Invalid email or password" };
  }

  const isPasswordValid = await bcrypt.compare(rawPassword, user.passwordHash);
  if (!isPasswordValid) {
    return { ok: false, status: 401, error: "Invalid email or password" };
  }

  const token = signAuthToken(user);
  return {
    ok: true,
    status: 200,
    token,
    user: toPublicUser(user),
  };
}

export async function getUserFromTokenClaims(claims) {
  const userId = claims?.sub?.toString();
  if (!userId) {
    return null;
  }

  const user = await usersDb.findOne({ _id: userId, isActive: true });
  if (!user) {
    return null;
  }

  return toPublicUser(user);
}
