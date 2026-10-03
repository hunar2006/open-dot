// Actual compiled server + browser UI, with synthetic catalog replies and no live keys.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
await import("./windows-test-loader.mjs");
const { ROUTER_PROVIDERS } = await import("../src/lib/model-providers.ts");
const root = path.resolve(import.meta.dirname, "..");
const commandCode = process.argv.includes("--commandcode");
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const serverDir = path.resolve(arg("--server", path.join(root, ".desktop/server")));
const browserExe = arg("--browser", path.join(root, ".desktop/browser/chromium-1243/chrome-win64/chrome.exe"));
const profile = fs.mkdtempSync(path.join(root, ".windows-check-router-picker-"));
const fixture = path.join(profile, "catalog.mjs"), requestLog = path.join(profile, "requests.jsonl");
fs.writeFileSync(fixture, `import fs from "node:fs";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({url:url.href,method}) + "\\n");
  if (${commandCode} && url.origin === "https://api.commandcode.ai" && url.pathname.startsWith("/provider/v1/")) {
    if (method === "GET" && url.pathname.endsWith("/models")) return Response.json({data:[{id:"deepseek/fixture-flash",supported_endpoints:["/chat/completions"]},{id:"claude-fixture",supported_endpoints:["/messages"]},{id:"typesafe/jev",supported_endpoints:["/systemone"]}]});
    const body = JSON.parse(init.body);
    if (method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const text = body.response_format ? '{"applying_rules":[]}' : body.stream ? "Chat Completion route completed the offline demo." : "Command Code demo";
      const c = {id:"chat_cmd",model:body.model,choices:[{index:0,message:{role:"assistant",content:text},finish_reason:"stop"}]};
      if (!body.stream) return Response.json(c);
      return new Response('data: '+JSON.stringify({id:c.id,model:body.model,choices:[{index:0,delta:{content:text},finish_reason:"stop"}]})+'\\n\\ndata: [DONE]\\n\\n',{headers:{"Content-Type":"text/event-stream"}});
    }
    if (method === "POST" && url.pathname.endsWith("/messages") && body.stream) {
      const resumed = body.messages.some(m=>m.content.some(b=>b.type==="tool_result"));
      const block = resumed ? {type:"text",text:""} : {type:"tool_use",id:"call_demo",name:"run_command",input:{}};
      const delta = resumed ? {type:"text_delta",text:"Command Code completed the offline demo."} : {type:"input_json_delta",partial_json:JSON.stringify({command:"Write-Output 'command-code-fixture'"})};
      const events=[{type:"message_start",message:{id:"msg_demo",model:body.model,content:[],stop_reason:null}},{type:"content_block_start",index:0,content_block:block},{type:"content_block_delta",index:0,delta},{type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:resumed?"end_turn":"tool_use"}},{type:"message_stop"}];
      return new Response(events.map(e=>'event: '+e.type+'\\ndata: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{"Content-Type":"text/event-stream"}});
    }
    throw new Error("Unsupported synthetic Command Code request");
  }
  if (method !== "GET" || url.origin !== "https://openrouter.ai" || url.pathname !== "/api/v1/models") throw new Error("External request refused by synthetic picker check");
  const data = [{id:"moonshotai/kimi-k3",supported_parameters:["tools"]},{id:"text-only-fixture",supported_parameters:["temperature"]},...Array.from({length:220},(_,i)=>({id:"paid-fixture-"+i,supported_parameters:["tools"]})),{id:"openrouter/free",supported_parameters:["tools","structured_outputs"]}];
  return Response.json({data:url.searchParams.has("supported_parameters") ? data.filter(m=>m.id!=="openrouter/free") : data});
};
`);
const env = { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "", PORT: "3105", HOSTNAME: "127.0.0.1", DOTS_DESKTOP_INSTANCE: crypto.randomUUID(), DOTS_PUBLIC_URL: "http://localhost:3105", DOTS_DATA_DIR: path.join(profile, "data"), DOTS_COMPUTER: "local", DOTS_MODEL: "", DOTS_REVIEW_MODEL: "", OPENAI_API_KEY: "", COMPOSIO_API_KEY: "", E2B_API_KEY: "" };
for (const p of ROUTER_PROVIDERS) { env[p.env] = ""; env[`${p.env.replace(/_API_KEY$/, "")}_BASE_URL`] = ""; }
env.OPENROUTER_API_KEY = commandCode ? "" : "fixture-picker-only-secret";
const server = spawn(process.execPath, ["--import", pathToFileURL(fixture).href, path.join(serverDir, "server.js")], { cwd: serverDir, env, windowsHide: true });
let output = "", browser;
server.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
server.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });
server.on("error", err => { output += err.message; });
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(output);
    const ready = await fetch("http://127.0.0.1:3105/api/desktop/health").catch(() => null);
    if (ready?.ok && await ready.text() === env.DOTS_DESKTOP_INSTANCE) break;
    if (i === 99) throw new Error("Synthetic picker server did not start: " + output);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ executablePath: browserExe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1300, height: 860 } });
  await page.goto("http://localhost:3105/settings");
  const picker = page.locator('button[aria-haspopup="listbox"]');
  const evidence = path.join(root, ".windows-check-output/evidence");
  fs.mkdirSync(evidence, { recursive: true });
  if (commandCode) {
    const routers = page.locator("#open-models");
    await routers.getByLabel("Router provider", { exact: true }).selectOption("commandcode");
    assert.equal(await routers.getByLabel("Router API base URL", { exact: true }).inputValue(), "https://api.commandcode.ai/provider/v1");
    await routers.getByLabel("Command Code API key", { exact: true }).fill("fixture-commandcode-ui-only-secret");
    await routers.getByRole("button", { name: "Save", exact: true }).click();
    await routers.getByText(/Saved encrypted.*2 models loaded/).waitFor();
    await page.screenshot({ path: path.join(evidence, "windows-commandcode-settings.png") });
    await picker.click();
    assert.equal(await page.getByRole("option", { name: /typesafe\/jev/ }).count(), 0);
    await page.getByRole("option", { name: /^claude-fixture/ }).click();
    await page.reload();
    await picker.filter({ hasText: "claude-fixture" }).waitFor();
    await page.goto("http://localhost:3105/new");
    await page.getByPlaceholder("Pixel", { exact: true }).fill("Command Code check");
    await page.getByPlaceholder("What should it help with?").fill("Synthetic Command Code chat, approval and tool check");
    await page.getByRole("button", { name: "Create Command Code check", exact: true }).click();
    await page.waitForURL(/\/dots\/dot_/);
    await picker.filter({ hasText: /Default.*claude-fixture/ }).waitFor();
    const composer = page.getByPlaceholder("Message Command Code check…", { exact: true });
    await composer.fill("Run the harmless offline demo command.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Approve", exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByText("Command Code completed the offline demo.", { exact: true }).waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(evidence, "windows-commandcode-chat.png") });
    await picker.click(); await page.getByRole("option", { name: /^deepseek\/fixture-flash/ }).click();
    await composer.fill("Check the other Command Code protocol.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Chat Completion route completed the offline demo.", { exact: true }).waitFor({ timeout: 30000 });
    const requests = fs.readFileSync(requestLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert(requests.every(r => new URL(r.url).origin === "https://api.commandcode.ai"));
    assert(requests.some(r => r.method === "POST" && new URL(r.url).pathname.endsWith("/messages")));
    assert(requests.some(r => r.method === "POST" && new URL(r.url).pathname.endsWith("/chat/completions")));
    console.log("PASS: compiled-server Command Code save, catalog filtering, encrypted profile, Settings/dot pickers, selection persistence, real bot/tool approval and resumed Claude/chat protocol switching; synthetic APIs only");
  } else {
  await picker.filter({ hasText: "openrouter/free" }).waitFor();
  await picker.click();
  const free = page.getByRole("option", { name: /^openrouter\/free/ });
  await free.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("option", { name: /text-only-fixture/ }).count(), 0);
  await page.screenshot({ path: path.join(evidence, "windows-free-model-picker.png") });
  await page.getByRole("option", { name: /^moonshotai\/kimi-k3/ }).click();
  await picker.filter({ hasText: "moonshotai/kimi-k3" }).waitFor();
  await page.reload();
  await picker.filter({ hasText: "moonshotai/kimi-k3" }).waitFor();
  await picker.click(); await free.click();
  await picker.filter({ hasText: "openrouter/free" }).waitFor();
  await page.goto("http://localhost:3105/new");
  await page.getByPlaceholder("Pixel", { exact: true }).fill("Free picker check");
  await page.getByPlaceholder("What should it help with?").fill("Synthetic model selection check; no inference");
  await page.getByRole("button", { name: "Create Free picker check", exact: true }).click();
  await page.waitForURL(/\/dots\/dot_/);
  await picker.filter({ hasText: /Default.*openrouter\/free/ }).waitFor();
  await picker.click(); await free.waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(evidence, "windows-dot-free-model-picker.png") });
  await page.getByRole("option", { name: /^moonshotai\/kimi-k3/ }).click();
  await picker.filter({ hasText: "moonshotai/kimi-k3" }).waitFor();
  await picker.click(); await page.getByRole("option", { name: /^Default/ }).click();
  await picker.filter({ hasText: /Default.*openrouter\/free/ }).waitFor();
  const requests = fs.readFileSync(requestLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert(requests.length > 0 && requests.every(r => r.method === "GET" && new URL(r.url).pathname === "/api/v1/models" && !new URL(r.url).searchParams.has("supported_parameters")));
  console.log("PASS: compiled-server free default, visible Settings/dot dropdowns, paid-to-free selection, reload persistence and dot inheritance; synthetic catalogs only, no inference");
  }
} catch (err) { throw new Error(`${err.message}\n${output}`, { cause: err }); }
finally {
  await browser?.close();
  if (server.exitCode === null) { const exited = new Promise(resolve => server.once("exit", resolve)); server.kill(); await exited; }
  if (path.dirname(profile) !== root || fs.lstatSync(profile).isSymbolicLink()) throw new Error("Unexpected picker profile cleanup target");
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
