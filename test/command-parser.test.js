import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/command-parser.js";

test("parses aliases, options and quoted arguments", () => {
  const command = parseCommand('/doc --name "论文分享" --path /研究/总结');
  assert.equal(command.name, "doc");
  assert.equal(command.options.name, "论文分享");
  assert.equal(command.options.path, "/研究/总结");
});

test("parses translation target and language", () => {
  const command = parseCommand("/trans Sec3 --lang English");
  assert.equal(command.name, "translate");
  assert.equal(command.target, "Sec3");
  assert.equal(command.options.lang, "English");
});

test("returns unknown command information", () => {
  const command = parseCommand("/unknown something");
  assert.equal(command.name, "unknown");
  assert.equal(command.alias, "unknown");
});
