#!/usr/bin/env node
/**
 * Smoke checks for sandbox backends (no full Tart image download required).
 */
import { getSandboxBackend, provisionSession, wipeSession } from "./sandbox.js";
import {
  tartAvailable,
  goldenImageReady,
  ensureVmDirs,
  GOLDEN_VM_NAME,
} from "./sandbox-vm.js";
import { ensureSandboxDirs, folderJobExists } from "./sandbox-folder.js";

let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}

ensureSandboxDirs();
ensureVmDirs();

const backend = getSandboxBackend();
ok("getSandboxBackend returns folder|vm", backend === "folder" || backend === "vm", backend);

ok("folder ensureSandboxDirs", true);
ok("vm ensureVmDirs", true);

const tart = tartAvailable();
console.log(`  tartAvailable=${tart} goldenImageReady=${goldenImageReady()} (${GOLDEN_VM_NAME})`);

// VM provision without golden must throw a clear error
const prev = process.env.BAY_SANDBOX_BACKEND;
process.env.BAY_SANDBOX_BACKEND = "vm";
try {
  if (!tart || !goldenImageReady()) {
    let threw = false;
    let msg = "";
    try {
      await provisionSession({
        reservationId: "smoke-missing-golden",
        agent: "claude",
        repoUrl: null,
      });
    } catch (err) {
      threw = true;
      msg = String(err.message || err);
    }
    ok(
      "vm provision fails clearly without Tart/golden",
      threw && /Tart|golden|guest:build/i.test(msg),
      msg.slice(0, 120)
    );
  } else {
    console.log("  (skipping missing-golden check — Tart + bay-golden present)");
  }
} finally {
  if (prev === undefined) delete process.env.BAY_SANDBOX_BACKEND;
  else process.env.BAY_SANDBOX_BACKEND = prev;
}

// wipe no-op safety
wipeSession("smoke-does-not-exist");
ok("wipeSession missing job is safe", !folderJobExists("smoke-does-not-exist"));

if (failed > 0) {
  console.error(`\n${failed} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nAll sandbox smoke checks passed");
