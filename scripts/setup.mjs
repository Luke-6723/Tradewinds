#!/usr/bin/env node
/**
 * Tradewinds one-time setup script.
 * Usage: node scripts/setup.mjs
 *
 * Walks through:
 *  1. Register an account (or skip if you already have one)
 *  2. Log in → get JWT
 *  3. List existing companies or create a new one
 *  4. Print .env.local variables to copy
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const BASE = "https://tradewinds.fly.dev/api/v1";

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

async function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  console.log(path, token)
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

async function get(path, token, companyId) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (companyId) headers["tradewinds-company-id"] = companyId;
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

async function main() {
  console.log("\n🚢 Tradewinds Setup\n");

  // ── Step 1: Register or skip ──────────────────────────────────────────────
  const wantRegister = (await ask("Register a new account? (y/n): ")).trim().toLowerCase();
  let token;

  if (wantRegister === "y") {
    const username = (await ask("Username: ")).trim();
    const password = (await ask("Password: ")).trim();
    const email = (await ask("Email: ")).trim();
    const discordId = (await ask("Discord ID: ")).trim();

    const reg = await post("/auth/register", { name: username, password, email, discord_id: discordId });
    if (!reg.ok) {
      console.error("Registration failed:", JSON.stringify(reg.data, null, 2));
      console.log("Proceeding to login…");
    } else {
      console.log("✅ Registered! Note: an admin needs to enable your account before you can trade.");
    }

    const login = await post("/auth/login", { email, password });
    if (!login.ok) {
      console.error("Login failed:", JSON.stringify(login.data, null, 2));
      rl.close(); process.exit(1);
    }
    token = login.data.token;
    console.log("✅ Logged in.");
  } else {
    const email = (await ask("Email: ")).trim();
    const password = (await ask("Password: ")).trim();
    const login = await post("/auth/login", { email, password });
    if (!login.ok) {
      console.error("Login failed:", JSON.stringify(login.data, null, 2));
      rl.close(); process.exit(1);
    }
    token = login.data.data.token;
    console.log("✅ Logged in.");
  }

  // ── Step 2: Company ────────────────────────────────────────────────────────
  const existing = await get("/companies", token);
  let companyId;

  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    console.log("\nExisting companies:");
    existing.data.forEach((c, i) => console.log(`  ${i + 1}. ${c.name} (${c.id})`));
    const pick = (await ask("Use existing company? Enter number or 'n' to create new: ")).trim();
    const idx = parseInt(pick, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= existing.data.length) {
      companyId = existing.data[idx - 1].id;
    }
  }

  if (!companyId) {
    // List ports first
    const ports = await get("/world/ports", token);
    console.log(ports);
    if (ports.ok && ports.data) {
      console.log("\nAvailable ports (recommended: London, Amsterdam, Hamburg, Edinburgh):");
      ports.data.data.slice(0, 20).forEach((p) => console.log(`  ${p.name} — ${p.id}`));
    }
    const companyName = (await ask("\nCompany name: ")).trim();
    const homePortId = (await ask("Home port ID: ")).trim();
    const created = await post("/companies", { name: companyName, ticker: companyName.toLowerCase().substring(0, 5), home_port_id: homePortId }, token);
    if (!created.ok) {
      console.error("Failed to create company:", JSON.stringify(created.data, null, 2));
      rl.close(); process.exit(1);
    }
    companyId = created.data.id;
    console.log(`✅ Company created: ${created.data.name}`);
  }

  // ── Step 3: Print env vars ─────────────────────────────────────────────────
  console.log("\n✅ Setup complete! Add these to your .env.local:\n");
  console.log(`TRADEWINDS_TOKEN=${token}`);
  console.log(`TRADEWINDS_COMPANY_ID=${companyId}`);
  console.log(`TRADEWINDS_API_URL=https://tradewinds.fly.dev`);
  console.log("\nThen run: pnpm dev\n");

  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
