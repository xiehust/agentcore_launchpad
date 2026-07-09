// Studio → Launchpad integration evidence (Launchpad-specific script).
import { chromium } from "/home/ubuntu/.nvm/versions/node/v22.19.0/lib/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("dialog", (d) => d.accept());

await page.goto("http://localhost:5273/", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/studio_1_boot.png" });

// import the sample flow json
const fileInput = await page.$('input[type="file"]');
if (!fileInput) throw new Error("no file input found for import");
await fileInput.setInputFiles(
  "/home/ubuntu/workspace/agentcore_launchpad/apps/studio/assets/aws_knowledge_mcp_agent.json",
);
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/studio_2_canvas.png" });
const nodeCount = await page.evaluate(
  () => document.querySelectorAll(".react-flow__node").length,
);
console.log("canvas nodes:", nodeCount);

// open the AgentCore deploy panel
await page.click("text=Deploy to Cloud");
await page.waitForTimeout(1000);
const agentcoreOpt = await page.$("text=AgentCore");
if (agentcoreOpt) {
  await agentcoreOpt.click();
  await page.waitForTimeout(800);
}
await page.waitForTimeout(1200);
const hasSection = await page.$("text=Deploy via Launchpad platform");
console.log("launchpad section visible:", !!hasSection);
if (!hasSection) {
  // dump visible tab labels for debugging
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll("button")].map((b) => b.textContent?.trim()).slice(0, 40),
  );
  console.log("buttons:", JSON.stringify(labels));
}
await page.screenshot({ path: "/tmp/studio_3_deploypanel.png" });

// generated code excerpt from the panel state (via code preview tab if present)
const codeTab = await page.$("text=Code Preview");
if (codeTab) {
  await codeTab.click();
  await page.waitForTimeout(800);
}
await page.screenshot({ path: "/tmp/studio_4_code.png" });

// fill launchpad agent name and deploy
await page.fill(".bg-amber-50 input", "studio-knowledge-agent");
await page.click(".bg-amber-50 button:has-text('Deploy')");
console.log("deploy clicked; polling…");
await page.waitForFunction(
  () => {
    const el = document.querySelector(".bg-amber-50 .font-mono");
    return el && /status: (active|failed)/.test(el.textContent ?? "");
  },
  null,
  { timeout: 600000, polling: 4000 },
);
const status = await page.evaluate(
  () => document.querySelector(".bg-amber-50 .font-mono")?.textContent?.slice(0, 400),
);
console.log("deploy status block:", status);
await page.screenshot({ path: "/tmp/studio_5_deployed.png" });

// cross-nav: studio → launchpad
const backLink = await page.$("text=← Launchpad");
console.log("back link present:", !!backLink);
await browser.close();
