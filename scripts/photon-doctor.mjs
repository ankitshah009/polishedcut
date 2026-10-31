#!/usr/bin/env node
/**
 * Photon Beta doctor: proves the credentials, the project and the lines from this machine, with
 * nothing but fetch. Reads PHOTON_API_KEY (or PHOTON_SPECTRUM_API_KEY) and PHOTON_PROJECT_ID from
 * the environment or .env in the cwd.
 *
 *   node scripts/photon-doctor.mjs                 # auth, project, platforms, lines, last messages
 *   node scripts/photon-doctor.mjs --watch         # also tail received messages for 2 minutes
 *   node scripts/photon-doctor.mjs --reply <messageId> "text"   # answer one received message
 *
 * Project API keys (pho_sk_…) work only under /v1/projects/{id}; account keys (pho_ask_…) can list
 * organizations and projects, which is how PHOTON_PROJECT_ID is discovered when it is unset.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const API = (process.env.PHOTON_API_URL ?? "https://api.photon.codes").replace(/\/+$/, "");
const KEY = (process.env.PHOTON_API_KEY ?? process.env.PHOTON_SPECTRUM_API_KEY ?? "").trim();
let PROJECT = (process.env.PHOTON_PROJECT_ID ?? "").trim();
const args = process.argv.slice(2);

if (!KEY) fail("PHOTON_API_KEY is not set (a Beta project API key, pho_sk_…, from app.beta.photon.codes -> project -> API keys)");
const kind = KEY.startsWith("pho_sk_") ? "project API key" : KEY.startsWith("pho_ask_") ? "account service key" : KEY.startsWith("eyJ") ? "access token (JWT)" : "unrecognised prefix (Beta keys start with pho_sk_ or pho_ask_; Stable Spectrum secrets are a different system)";
console.log(`key:      ${KEY.slice(0, 11)}… (${kind})`);
console.log(`api:      ${API}`);

async function call(path, init = {}) {
  const headers = { authorization: `Bearer ${KEY}`, ...(init.body && !(init.body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) };
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const p = typeof body === "object" && body ? body : {};
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${p.code ?? ""} ${p.title ?? ""} ${p.detail ?? ""} (request ${res.headers.get("x-request-id") ?? "?"})`.replace(/\s+/g, " "));
  }
  return body;
}

if (!PROJECT) {
  if (!KEY.startsWith("pho_ask_")) fail("PHOTON_PROJECT_ID is not set; copy the pho_prj_… id from Settings in the Beta dashboard (a project key cannot list projects)");
  const orgs = await call("/v1/organizations");
  const projects = [];
  for (const org of orgs.items ?? orgs.organizations ?? orgs) {
    const id = org.organizationId ?? org.id;
    const list = await call(`/v1/organizations/${id}/projects`);
    for (const p of list.items ?? list.projects ?? list) projects.push(p);
  }
  console.log(`projects: ${projects.map((p) => `${p.projectId} (${p.name})`).join(", ") || "none"}`);
  if (projects.length !== 1) fail("set PHOTON_PROJECT_ID to one of the ids above");
  PROJECT = projects[0].projectId;
}
console.log(`project:  ${PROJECT}`);
const P = `/v1/projects/${PROJECT}`;

if (args[0] === "--reply") {
  const [, messageId, ...rest] = args;
  const msg = await call(`${P}/messages/${messageId}`);
  const sent = await call(`${P}/messages`, {
    method: "POST",
    headers: { "idempotency-key": `doctor:${messageId}:${randomUUID()}` },
    body: JSON.stringify({ spaceId: msg.space.id, senderId: msg.receivedBy.id, parentMessageId: msg.id, content: { type: "text", format: "plain", text: rest.join(" ") || "PolishedCut test reply" } }),
  });
  console.log(`sent:     ${sent.id} status=${sent.status} platform=${sent.platform}`);
  process.exit(0);
}

const platforms = await call(`${P}/platforms`);
console.log(`platforms: ${(platforms.platforms ?? []).map((p) => p.type).join(", ") || "none"}`);
try {
  const im = await call(`${P}/platforms/imessage`);
  console.log(`imessage: ${JSON.stringify(im).slice(0, 300)}`);
} catch (e) { console.log(`imessage: ${e.message}`); }
try {
  const lines = await call(`${P}/platforms/imessage/assignments`);
  const items = lines.items ?? lines.assignments ?? [];
  console.log(`imessage shared lines: ${items.length}`);
  for (const a of items) console.log(`  ${a.assignedPhoneNumber} <- ${a.handle} (${a.assignmentId})${a.releasedAt ? " released" : ""}`);
} catch (e) { console.log(`imessage assignments: ${e.message}`); }
try {
  const res = await call(`${P}/platforms/resources`);
  const items = res.items ?? res.resources ?? [];
  console.log(`resources (lines/numbers): ${items.length}`);
  for (const r of items) console.log(`  ${JSON.stringify(r).slice(0, 220)}`);
} catch (e) { console.log(`resources: ${e.message}`); }

async function recent(since) {
  const q = new URLSearchParams({ direction: "received", order: "asc", pageSize: "20", ...(since ? { createdSince: since } : {}) });
  const page = await call(`${P}/messages?${q}`);
  return page.items ?? [];
}
const msgs = await recent();
console.log(`received messages (last ${msgs.length}):`);
for (const m of msgs.slice(-10)) console.log(`  ${m.createdAt} ${m.platform} ${m.id} from ${m.sentBy?.handle ?? m.sentBy?.id} space ${m.space?.id} content=${m.content?.type}${m.content?.type === "text" ? ` "${m.content.text.slice(0, 60)}"` : m.content?.type === "attachment" ? ` ${m.content.attachmentId}` : ""}`);

if (args[0] === "--watch") {
  let since = new Date().toISOString();
  const seen = new Set(msgs.map((m) => m.id));
  console.log("watching for new received messages for 120s… text the line now");
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2000));
    for (const m of await recent(since)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      console.log(`  NEW ${m.createdAt} ${m.platform} ${m.id} from ${m.sentBy?.handle ?? m.sentBy?.id} content=${JSON.stringify(m.content).slice(0, 200)}`);
      since = m.createdAt;
    }
  }
}

function fail(msg) {
  console.error(`doctor: ${msg}`);
  process.exit(1);
}
