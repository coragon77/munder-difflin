#!/usr/bin/env node
'use strict';

/**
 * md-detach-client — the kitty side of the harness detach bridge
 * (card harness-detach-to-kitty-20260817).
 *
 * Runs INSIDE a kitty window (launched by the harness main process, under
 * ELECTRON_RUN_AS_NODE). Plain node, zero deps:
 *
 *   dataSock — raw bytes both ways with the agent's LIVE pty:
 *              stdin (raw mode) -> socket, socket -> stdout.
 *   ctlSock  — JSON lines: {"t":"hello"|"resize", cols, rows} out (the
 *              kitty window owns the pty size while detached),
 *              {"t":"bye"} in -> exit 0 (kitty closes the window with us).
 *
 * Any socket dying ends the client: the harness either reattached (bye) or
 * quit (pty gone with it) — either way the window has nothing to show.
 *
 * Usage: md-detach-client <dataSock> <ctlSock>
 */
const net = require('node:net');

const [dataSock, ctlSock] = process.argv.slice(2);
if (!dataSock || !ctlSock) {
  console.error('usage: md-detach-client <dataSock> <ctlSock>');
  process.exit(2);
}

const out = process.stdout;
const size = () => {
  if (out.isTTY && typeof out.getWindowSize === 'function') {
    const [cols, rows] = out.getWindowSize();
    return [cols, rows];
  }
  return [80, 24]; // piped stdio (tests) — safe fallback grid
};

let done = false;
const data = net.connect(dataSock);
const ctl = net.connect(ctlSock);

const finish = (msg) => {
  if (done) return;
  done = true;
  try {
    if (msg) out.write(msg);
  } catch {
    /* stdout gone */
  }
  try {
    data.destroy();
  } catch {
    /* gone */
  }
  try {
    ctl.destroy();
  } catch {
    /* gone */
  }
  process.exit(0);
};

const sendSize = (t) => {
  const [cols, rows] = size();
  try {
    ctl.write(`${JSON.stringify({ t, cols, rows })}\n`);
  } catch {
    /* ctl gone — its close handler finishes us */
  }
};

ctl.on('connect', () => sendSize('hello'));
ctl.on('data', (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).t === 'bye') finish('');
    } catch {
      /* not JSON — ignore */
    }
  }
});
if (out.isTTY) out.on('resize', () => sendSize('resize'));

// Raw key passthrough: every byte the user types in kitty goes to the pty
// verbatim; no line buffering, no local echo (the pty owns the echo).
if (process.stdin.isTTY) {
  try {
    process.stdin.setRawMode(true);
  } catch {
    /* raw mode unavailable — passthrough still works line-wise */
  }
}
process.stdin.resume();
process.stdin.on('data', (d) => {
  try {
    data.write(d);
  } catch {
    /* data gone */
  }
});

data.on('data', (d) => {
  try {
    out.write(d);
  } catch {
    /* stdout gone */
  }
});
data.on('close', () => finish('\r\n\x1b[2m— harness bridge closed —\x1b[0m\r\n'));
data.on('error', () => finish('\r\n[harness bridge gone]\r\n'));
ctl.on('close', () => finish(''));
ctl.on('error', () => finish(''));
process.on('SIGTERM', () => finish(''));
process.on('SIGHUP', () => finish(''));
