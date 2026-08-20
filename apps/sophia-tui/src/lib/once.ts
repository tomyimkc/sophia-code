import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BridgeEvent } from "./bridge.js";

export function onceExitCode(payload: BridgeEvent): number {
  return payload.ok === true ? 0 : 1;
}

export function formatFinishedPayload(payload: BridgeEvent): string {
  return JSON.stringify(payload);
}

export function writeFinishedPayload(
  payload: BridgeEvent,
  finishedOut?: string,
  writeStdout: (text: string) => void = (text) => process.stdout.write(text),
): void {
  const line = formatFinishedPayload(payload) + "\n";
  if (!finishedOut) {
    writeStdout(line);
    return;
  }
  const target = path.resolve(finishedOut);
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, line, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
  chmodSync(target, 0o600);
}
