#!/usr/bin/env node
/**
 * Dial host Tart bridge and pipe to a local guest port.
 * Keeps a small pool of standby connections for the host reverse-bridge.
 *
 * Env:
 *   BAY_HOST_GW=192.168.64.1
 *   BAY_BRIDGE_PORT=13400
 *   BAY_TARGET_PORT=3400
 *   BAY_POOL=6
 */
import net from "node:net";

const host = process.env.BAY_HOST_GW || "192.168.64.1";
const bridgePort = Number(process.env.BAY_BRIDGE_PORT || "13400");
const targetPort = Number(process.env.BAY_TARGET_PORT || "3400");
const pool = Math.max(2, Number(process.env.BAY_POOL || "6"));

function dial() {
  const up = net.connect(bridgePort, host);
  let down = null;
  let settled = false;

  const retry = () => {
    if (settled) return;
    settled = true;
    try {
      up.destroy();
    } catch {
      // ignore
    }
    try {
      down?.destroy();
    } catch {
      // ignore
    }
    setTimeout(dial, 400);
  };

  up.on("connect", () => {
    down = net.connect(targetPort, "127.0.0.1");
    down.on("connect", () => {
      up.pipe(down);
      down.pipe(up);
    });
    down.on("error", retry);
    down.on("close", retry);
  });
  up.on("error", retry);
  up.on("close", retry);
}

for (let i = 0; i < pool; i += 1) {
  setTimeout(dial, i * 50);
}
