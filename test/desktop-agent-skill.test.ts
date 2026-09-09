import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AgentSkill, agentSkillPath } from "../src/desktop/agent-skill.js";

const content =
  "---\nname: embassys\ndescription: Communicate with another person's agent.\n---\nUse the configured Embassys tools.\n";
test("skill paths follow each reviewed provider profile without embedding an account or port", () => {
  const home = join(tmpdir(), "skill-owner");
  assert.equal(
    agentSkillPath("codex", join(home, ".codex", "config.toml"), home),
    join(home, ".agents", "skills", "embassys", "SKILL.md"),
  );
  assert.equal(
    agentSkillPath("claude_code", join(home, ".claude.json"), home),
    join(home, ".claude", "skills", "embassys", "SKILL.md"),
  );
  assert.equal(
    agentSkillPath("claude_code", join(home, "profile", ".claude.json"), home),
    join(home, "profile", "skills", "embassys", "SKILL.md"),
  );
  for (const provider of ["openclaw", "hermes"] as const)
    assert.equal(
      agentSkillPath(provider, join(home, provider, "config.json"), home),
      join(home, provider, "skills", "embassys", "SKILL.md"),
    );
});

test("skill install, repeat, repair and disconnect preserve unrelated files and ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "skills", "embassys", "SKILL.md");
  const skill = new AgentSkill({ path, ownershipPath: join(root, "owner.json"), content });
  assert.equal((await skill.inspect()).state, "missing");
  assert.equal((await skill.install()).state, "installed");
  assert.equal((await skill.install()).owned, true);
  await writeFile(join(dirname(path), "notes.txt"), "keep");
  await rm(path);
  assert.equal((await skill.install()).state, "installed");
  assert.equal((await skill.remove()).state, "missing");
  assert.equal(await readFile(join(dirname(path), "notes.txt"), "utf8"), "keep");
  await writeFile(path, content);
  assert.equal((await skill.install()).owned, false);
  await skill.remove();
  assert.equal(await readFile(path, "utf8"), content);
});

test("skill edits, linked files and linked directories are never replaced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-skill-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "skills", "embassys", "SKILL.md");
  const skill = new AgentSkill({ path, ownershipPath: join(root, "owner.json"), content });
  await skill.install();
  await writeFile(path, "owner edited");
  assert.equal((await skill.install()).state, "conflict");
  assert.equal((await skill.remove()).state, "conflict");
  assert.equal(await readFile(path, "utf8"), "owner edited");
  await rm(path);
  const target = join(root, "target");
  await writeFile(target, "keep");
  await symlink(target, path);
  assert.equal((await skill.install()).state, "conflict");
  await rm(dirname(path), { recursive: true });
  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), dirname(path), "junction");
  assert.equal((await skill.install()).state, "conflict");
  assert.equal(await readFile(target, "utf8"), "keep");
});

test("an interrupted skill write reconciles and an owned older skill upgrades without losing manual content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-skill-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "skills", "embassys", "SKILL.md");
  const ownershipPath = join(root, "owner.json");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  await writeFile(
    ownershipPath,
    JSON.stringify({ version: 1, path, hash: hash(content), removed: false }),
  );
  const skill = new AgentSkill({ path, ownershipPath, content });
  assert.equal((await skill.install()).owned, true);
  const update = new AgentSkill({
    path,
    ownershipPath,
    content: `${content}\nRetain the request ID.\n`,
  });
  assert.equal((await update.install()).state, "installed");
  assert.equal(await readFile(path, "utf8"), `${content}\nRetain the request ID.\n`);
  assert.equal((await update.remove()).state, "missing");
});
