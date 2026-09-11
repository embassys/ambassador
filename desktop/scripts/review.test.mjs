import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "embassys-review-ui-"));
await build({
  stdin: {
    contents: `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ReviewContent} from './src/review-sheet.tsx'; export const view = (review,choice='') => renderToStaticMarkup(createElement(ReviewContent,{review,choice,choose:()=>{},busy:false,submit:()=>{},cancel:()=>{}}));`,
    resolveDir: process.cwd(),
    sourcefile: "review-test.tsx",
  },
  outfile: join(root, "review.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  banner: {
    js: `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);`,
  },
});
const { view } = await import(pathToFileURL(join(root, "review.mjs")).href);
test.after(() => rm(root, { recursive: true, force: true }));
test("provider options stay exact and wrapped in labels, with no default approval and short actions", () => {
  const label = `Yes, and do not ask again for ${"this provider tool ".repeat(20)}`;
  const review = {
    id: "one",
    kind: "permission",
    instanceName: "Local",
    permission: {
      title: "mcp__ambassador__get_my_permissions",
      detail: '{"rawInput":{"name":"<img src=x onerror=steal()>"}}',
      options: [{ optionId: "opaque:keep-me", name: label, kind: "allow_always" }],
    },
  };
  const html = view(review);
  assert.ok(html.includes(label));
  assert.match(html, /value="opaque:keep-me"/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Continue<\/button>/);
  assert.match(html, /<details[^>]*><summary>Technical details/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|onerror="/);
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.doesNotMatch(view(review, "opaque:keep-me"), /<button[^>]*disabled=""[^>]*>Continue/);
});
test("connection locations are labelled code fields in collapsed details", () => {
  const html = view({
    id: "two",
    kind: "connection",
    instanceName: "Local",
    providerName: "Claude Code",
    action: "Connect",
    endpoint: "http://127.0.0.1:8787/mcp",
    configurationPath: "/Users/test/Agent settings/.claude.json",
    skillPath: "/Users/test/skills/<untrusted>/SKILL.md",
  });
  assert.match(html, /<details[^>]*><summary>Connection details/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(html, /<dt>Agent settings<\/dt><dd><code>/);
  assert.match(html, /&lt;untrusted&gt;/);
  assert.match(html, />Connect<\/button>/);
  assert.doesNotMatch(html, />Connect Claude Code<\/button>/);
});
