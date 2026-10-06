import { describe, expect, it } from "vitest";
import { DsmlStreamFilter, extractDsmlToolCalls } from "../src/qoder/dsml.js";

const P = "\uFF5C";

const open = (name: string, attrs = ""): string => `<${P}DSML${P}${name}${attrs}>`;
const close = (name: string): string => `</${P}DSML${P}${name}>`;
// V4.1 drift: doubled fullwidth pipes and a space before the local name.
const spacedOpen = (name: string, attrs = ""): string => `<${P}${P}DSML${P}${P} ${name}${attrs}>`;
const spacedClose = (name: string): string => `</${P}${P}DSML${P}${P} ${name}>`;
const param = (name: string, value: string, attrs = ' string="true"'): string =>
  `${open("parameter", ` name="${name}"${attrs}`)}${value}${close("parameter")}`;

function canonicalBlock(): string {
  return [
    open("tool_calls"),
    open("invoke", ' name="read_file"'),
    param("path", "README.md"),
    close("invoke"),
    close("tool_calls"),
  ].join("\n");
}

describe("extractDsmlToolCalls", () => {
  it("converts a canonical block and strips it from the text", () => {
    const { calls, text } = extractDsmlToolCalls(`before\n${canonicalBlock()}\nafter`);
    expect(calls).toEqual([{ name: "read_file", arguments: JSON.stringify({ path: "README.md" }) }]);
    expect(text).not.toContain("DSML");
    expect(text).toContain("before");
    expect(text).toContain("after");
  });

  it("tolerates the spaced V4.1 wrapper", () => {
    const block = [
      spacedOpen("calls"),
      spacedOpen("invoke", ' name="bash"'),
      `${spacedOpen("parameter", ' name="command" string="true"')}ls -la${spacedClose("parameter")}`,
      spacedClose("invoke"),
      spacedClose("calls"),
    ].join("\n");
    const { calls } = extractDsmlToolCalls(block);
    expect(calls).toEqual([{ name: "bash", arguments: JSON.stringify({ command: "ls -la" }) }]);
  });

  it("parses multiple invokes and coerces string=false values", () => {
    const block = [
      open("tool_calls"),
      open("invoke", ' name="bash"'),
      param("command", "ls -la"),
      param("timeout", "30", ' string="false"'),
      close("invoke"),
      open("invoke", ' name="read_file"'),
      param("path", "a.ts"),
      close("invoke"),
      close("tool_calls"),
    ].join("");
    const { calls } = extractDsmlToolCalls(block);
    expect(calls).toEqual([
      { name: "bash", arguments: JSON.stringify({ command: "ls -la", timeout: 30 }) },
      { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
    ]);
  });

  it("ignores DSML shown inside a fenced code block", () => {
    const input = `\`\`\`\n${canonicalBlock()}\n\`\`\`\n${canonicalBlock()}`;
    const { calls, text } = extractDsmlToolCalls(input);
    expect(calls).toHaveLength(1);
    expect(text).toContain("```");
  });

  it("leaves an unterminated block untouched", () => {
    const input = `hi ${open("tool_calls")} partial`;
    const { calls, text } = extractDsmlToolCalls(input);
    expect(calls).toEqual([]);
    expect(text).toBe(input);
  });
});

describe("DsmlStreamFilter", () => {
  it("passes ordinary text straight through", () => {
    const filter = new DsmlStreamFilter();
    expect(filter.push("hello world")).toBe("hello world");
    expect(filter.takeCalls()).toEqual([]);
  });

  it("does not hold back HTML-looking text", () => {
    const filter = new DsmlStreamFilter();
    expect(filter.push("<div>hi")).toBe("<div>hi");
  });

  it("holds a dangling marker and releases it on flush", () => {
    const filter = new DsmlStreamFilter();
    expect(filter.push("text <")).toBe("text ");
    expect(filter.flush()).toBe("<");
  });

  it("converts a DSML block that arrives split across chunks", () => {
    const filter = new DsmlStreamFilter();
    const block = canonicalBlock();
    let emitted = "";
    for (const ch of block) emitted += filter.push(ch);
    emitted += filter.flush();
    expect(filter.takeCalls()).toEqual([{ name: "read_file", arguments: JSON.stringify({ path: "README.md" }) }]);
    expect(emitted).not.toContain("DSML");
  });

  it("emits visible text without leaking the DSML block", () => {
    const filter = new DsmlStreamFilter();
    const stream = `Here is the plan.\n${canonicalBlock()}\nDone.`;
    let emitted = "";
    for (let i = 0; i < stream.length; i += 3) emitted += filter.push(stream.slice(i, i + 3));
    emitted += filter.flush();
    expect(filter.takeCalls()).toHaveLength(1);
    expect(emitted).toContain("Here is the plan.");
    expect(emitted).toContain("Done.");
    expect(emitted).not.toContain("DSML");
  });
});
