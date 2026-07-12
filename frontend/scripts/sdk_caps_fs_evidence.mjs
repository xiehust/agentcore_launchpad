// Task 07-12-agent-sdk-capabilities-fs evidence: container CAPABILITIES with
// registry chips, custom zip/git skill attach, FILESYSTEM config states,
// edit/re-publish reload. All API responses stubbed via page.route — no AWS.
// Usage: node frontend/scripts/sdk_caps_fs_evidence.mjs [baseUrl]
import { mkdirSync } from "node:fs";
import { chromium } from "/home/ubuntu/.nvm/versions/node/v22.19.0/lib/node_modules/playwright/index.mjs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const OUT = "design/screenshots/agent-sdk-caps-fs";
mkdirSync(OUT, { recursive: true });

const ATTACHABLES = {
  mcp_servers: [
    { name: "deepwiki", description: "wiki lookup", url: "https://mcp.deepwiki.com/mcp", gateway: false },
    { name: "corp-tools", description: "gateway target", url: "https://gw.example/mcp", gateway: true },
  ],
  skills: [
    { name: "web-analyzer", description: "Analyze webpages", path: "s3://bkt/skills/web-analyzer/" },
    { name: "meeting-summarizer", description: "Summarize meetings", path: "s3://bkt/skills/meeting-summarizer/" },
  ],
};

const ZIP_INSPECT = {
  staging_id: "stg-zip-1",
  skills: [{
    index: 0, name: "custom-notes", description: "Take structured notes", version: "1.0.0",
    files: ["SKILL.md", "scripts/notes.py"], skill_md_excerpt: "# custom-notes",
    source: { kind: "zip" }, valid: true, errors: [],
  }],
};
const ZIP_ATTACH = {
  skills: [{ name: "custom-notes", ok: true, path: "s3://bkt/agent-skills/ab12cd34/custom-notes/", description: "Take structured notes" }],
};

const GIT_INSPECT = {
  staging_id: "stg-git-1",
  skills: [
    { index: 0, name: "pdf-tools", description: "Fill PDF forms", version: "1.0.0", files: ["SKILL.md"], skill_md_excerpt: "", source: { kind: "git" }, valid: true, errors: [] },
    { index: 1, name: "xlsx-tools", description: "Spreadsheets", version: "1.0.0", files: ["SKILL.md"], skill_md_excerpt: "", source: { kind: "git" }, valid: true, errors: [] },
    { index: 2, name: "broken-skill", description: "", version: "", files: [], skill_md_excerpt: "", source: { kind: "git" }, valid: false, errors: ["missing SKILL.md"] },
  ],
};
const GIT_ATTACH = {
  skills: [
    { name: "pdf-tools", ok: true, path: "s3://bkt/agent-skills/ef56gh78/pdf-tools/", description: "Fill PDF forms" },
    { name: "xlsx-tools", ok: true, path: "s3://bkt/agent-skills/ef56gh78/xlsx-tools/", description: "Spreadsheets" },
  ],
};

const EDIT_AGENT = {
  id: "a-fs-1", name: "sdk-fs-agent", method: "container", status: "active",
  arn: "arn:aws:bedrock-agentcore:us-west-2:111:runtime/x", resource_id: "rt-1",
  version: "3", owner: "river", error: null, revision: 3, created_at: "2026-07-12T08:00:00",
  updated_at: "2026-07-12T10:30:00",
  deployment: null, deployments: [],
  spec: {
    name: "sdk-fs-agent", method: "container", model_id: "global.anthropic.claude-sonnet-4-6",
    system_prompt: "You are a data analyst with a persistent workspace.",
    tools: [{ type: "mcp", name: "deepwiki", config: { url: "https://mcp.deepwiki.com/mcp" } }],
    skills: ["s3://bkt/skills/web-analyzer/", "s3://bkt/agent-skills/ab12cd34/custom-notes/"],
    memory: { short_term: true, long_term: true },
    env: { LAUNCHPAD_MCP_SERVERS: '{"docs": {"command": "uvx", "args": ["mcp-server-docs"]}}' },
    filesystem: {
      session_storage: { mount_path: "/mnt/workspace" },
      s3_files: [{ access_point_arn: "arn:aws:s3files:us-west-2:111122223333:file-system/fs-a/access-point/ap-1", mount_path: "/mnt/datasets" }],
      efs: [],
    },
    network: { subnets: ["subnet-0abc", "subnet-0def"], security_groups: ["sg-0abc"] },
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
await page.route("**/api/registry/attachables", (r) => r.fulfill(json(ATTACHABLES)));
await page.route("**/api/agents", (r) => r.fulfill(json({ agents: [EDIT_AGENT] })));

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

await page.goto(`${BASE}/create`, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.setItem("i18nextLng", "en"));
await page.reload({ waitUntil: "networkidle" });

// 1 ── container method → step 2: registry MCP chips + skills picker + FS default
await page.click('[data-method="container"]');
await page.click("button:has-text('▸')");
await page.waitForSelector("text=CAPABILITIES — CLAUDE SDK");
await page.fill("#agent-name", "sdk-fs-agent");
await page.fill("#agent-prompt", "You are a data analyst with a persistent workspace.");
await page.click(".selchip:has-text('deepwiki · mcp')");
await page.click(".selchip:has-text('web-analyzer · skill')");
await shot("01-container-capabilities-registry-linked");

// 2 ── custom zip source: upload → auto-attach as custom chip
await page.route("**/api/registry/skills/inspect", (r) => r.fulfill(json(ZIP_INSPECT)));
await page.route("**/api/agent-skills/import", (r) => r.fulfill(json(ZIP_ATTACH)));
await page.setInputFiles('input[type="file"]', {
  name: "custom-notes.zip", mimeType: "application/zip", buffer: Buffer.from("PK\x05\x06stub"),
});
await page.waitForSelector(".selchip:has-text('custom-notes · custom')");
await shot("02-custom-zip-attached");

// 3 ── custom git source: monorepo → picker → attach two
await page.unroute("**/api/registry/skills/inspect");
await page.unroute("**/api/agent-skills/import");
await page.route("**/api/registry/skills/inspect", (r) => r.fulfill(json(GIT_INSPECT)));
await page.route("**/api/agent-skills/import", (r) => r.fulfill(json(GIT_ATTACH)));
await page.click(".selchip:has-text('from git')");
await page.fill('input[placeholder*="github.com"]', "https://github.com/anthropics/skills");
await page.click("button:has-text('FETCH')");
await page.waitForSelector("text=DISCOVERED — SELECT TO ATTACH");
await page.click(".selchip:has-text('pdf-tools')");
await page.click(".selchip:has-text('xlsx-tools')");
await shot("03-git-monorepo-picker");
await page.click("button:has-text('ATTACH (2)')");
await page.waitForSelector(".selchip:has-text('pdf-tools · custom')");
await shot("04-git-skills-attached");

// 4 ── filesystem: default ON → disable session storage
await page.click(".selchip:has-text('managed session storage')");
await shot("05-fs-session-disabled");
await page.click(".selchip:has-text('managed session storage')"); // back on

// 5 ── BYO S3 mount reveals VPC requirement; empty VPC blocks launch
await page.click(".selchip:has-text('+ s3 files mount')");
await page.fill('input[placeholder*="s3files"]', "arn:aws:s3files:us-west-2:111122223333:file-system/fs-a/access-point/ap-1");
await page.fill('[data-testid="fs-config"] input[placeholder="/mnt/data"]', "/mnt/datasets");
await page.waitForSelector("text=VPC — REQUIRED FOR BYO MOUNTS");
const launchDisabled = await page.$eval("button:has-text('LAUNCH')", (b) => b.disabled).catch(() => null);
await shot("06-byo-s3-vpc-required-launch-blocked");

// 6 ── VPC filled → launch unblocked
await page.fill('input[placeholder*="subnet-"]', "subnet-0abc, subnet-0def");
await page.fill('input[placeholder="sg-0abc"]', "sg-0abc");
const launchEnabled = await page.$eval("button:has-text('LAUNCH')", (b) => !b.disabled).catch(() => null);
await shot("07-byo-s3-vpc-filled");
console.log("launch blocked without VPC:", launchDisabled, "· enabled with VPC:", launchEnabled);

// 7 ── edit/re-publish reload: stored container spec round-trips into the form
await page.goto(`${BASE}/create`, { waitUntil: "networkidle" });
await page.click("button.rowact:has-text('Edit')");
await page.waitForSelector("text=CAPABILITIES — CLAUDE SDK");
await shot("08-edit-reload-container-spec");

// 8 ── zh-CN of the filesystem group
await page.evaluate(() => localStorage.setItem("i18nextLng", "zh-CN"));
await page.reload({ waitUntil: "networkidle" });
await page.click('[data-method="container"]');
await page.click("button:has-text('▸')");
await page.waitForSelector("text=文件系统 — AGENTCORE RUNTIME");
await shot("09-fs-group-zh");

await browser.close();
console.log("evidence written to", OUT);
