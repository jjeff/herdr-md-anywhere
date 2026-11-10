// Run: node test/mentions.test.mjs
import assert from "node:assert/strict";
import { mentions } from "../mentions.js";

const text = "Read `docs/PLAN.md:12`, see ~/notes/a.md. Also https://x.com/b.md and (README.md) then docs/PLAN.md again; file:///tmp/z.mdx";
assert.deepEqual(mentions(text), ["/tmp/z.mdx", "docs/PLAN.md", "README.md", "~/notes/a.md"]);
assert.deepEqual(mentions("no markdown here, just notes.txt"), []);
console.log("mentions: ok");
