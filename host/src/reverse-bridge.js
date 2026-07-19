#!/usr/bin/env node
/**
 * Pair local Connect traffic (127.0.0.1) with guest-initiated dials.
 * Needed because macOS Local Network privacy often blocks host→VM (192.168.64.x),
 * while the guest can still reach the Tart bridge gateway (*.1).
 *
 * Usage:
 *   node reverse-bridge.js --bind 192.168.64.1 --bridge 13400 --local 3400
 */
import net from "node:net";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const bindHost = arg("bind", "192.168.64.1");
const bridgePort = Number(arg("bridge", "13400"));
const localPort = Number(arg("local", "3400"));

const guestPool = [];
const clientPool = [];

function drop(list, sock) {
  const i = list.indexOf(sock);
  if (i >= 0) list.splice(i, 1);
}

function pipe(a, b) {
  a.pipe(b);
  b.pipe(a);
  const close = () => {
    try {
      a.destroy();
    } catch {
      // ignore
    }
    try {
      b.destroy();
    } catch {
      // ignore
    }
  };
  a.on("error", close);
  b.on("error", close);
  a.on("close", close);
  b.on("close", close);
}

function pair() {
  while (guestPool.length && clientPool.length) {
    const g = guestPool.shift();
    const c = clientPool.shift();
    pipe(g, c);
  }
}

const bridge = net.createServer((sock) => {
  sock.on("error", () => {});
  sock.on("close", () => drop(guestPool, sock));
  guestPool.push(sock);
  pair();
});

const local = net.createServer((sock) => {
  sock.on("error", () => {});
  sock.on("close", () => drop(clientPool, sock));
  clientPool.push(sock);
  pair();
});

bridge.listen(bridgePort, bindHost, () => {
  local.listen(localPort, "127.0.0.1", () => {
    console.log(
      JSON.stringify({
        ok: true,
        bindHost,
        bridgePort,
        localPort,
      })
    );
  });
});

bridge.on("error", (err) => {
  console.error("bridge listen failed:", err.message);
  process.exit(1);
});
local.on("error", (err) => {
  console.error("local listen failed:", err.message);
  process.exit(1);
});
