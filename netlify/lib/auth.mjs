// Same · accounts. Free: users and sessions live in Netlify Blobs. Passwords are scrypt-hashed, never stored.
//   users/<sha256(email)>.json   {email, name, brand, salt, hash, created, role, orders:[order keys]}
//   sessions/<token>.json        {email, exp}
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { getJSON, putJSON, store } from "./r2.mjs";

const COOKIE = "same_s";
const DAYS = 90;
export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length < 200;
const uKey = (email) => `users/${createHash("sha256").update(normEmail(email)).digest("hex")}.json`;

export async function getUser(email) { return getJSON(uKey(email)); }
export async function saveUser(u) { await putJSON(uKey(u.email), u); }

export async function createUser({ email, password, name, brand }) {
  email = normEmail(email);
  if (!validEmail(email)) throw new Error("That email doesn't look right.");
  if (String(password || "").length < 8) throw new Error("Pick a password of 8 or more characters.");
  if (await getUser(email)) throw new Error("There's already an account with this email. Log in instead.");
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  const u = { email, name: String(name || "").slice(0, 120), brand: String(brand || "").slice(0, 200), salt, hash, created: Date.now(), role: "client", orders: [] };
  await saveUser(u);
  return u;
}

export async function checkPassword(email, password) {
  const u = await getUser(email);
  if (!u) return null;
  const a = Buffer.from(u.hash, "hex"), b = scryptSync(String(password || ""), u.salt, 64);
  return a.length === b.length && timingSafeEqual(a, b) ? u : null;
}

export async function newSession(email) {
  const token = randomBytes(24).toString("hex");
  await putJSON(`sessions/${token}.json`, { email: normEmail(email), exp: Date.now() + DAYS * 86400000 });
  return token;
}
export async function endSession(req) {
  const t = readToken(req); if (t) await store().delete(`sessions/${t}.json`);
}
function readToken(req) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{48})`));
  return m ? m[1] : null;
}
export async function currentUser(req) {
  const t = readToken(req); if (!t) return null;
  const s = await getJSON(`sessions/${t}.json`);
  if (!s || s.exp < Date.now()) return null;
  return getUser(s.email);
}
export const sessionCookie = (token) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export const publicUser = (u) => u && ({ email: u.email, name: u.name, brand: u.brand, role: u.role, created: u.created, orders: (u.orders || []).length });
