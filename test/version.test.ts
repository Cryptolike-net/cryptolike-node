import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION, USER_AGENT } from "../src/index.ts";

test("VERSION matches package.json and the User-Agent format", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.equal(USER_AGENT, `cryptolike-sdk-typescript/${pkg.version}`);
});
