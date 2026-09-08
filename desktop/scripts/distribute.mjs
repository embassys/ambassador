import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyBom, runArchiveTool, sha256, verifyInventory } from "./artifact-tools.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const evidence = JSON.parse(
  await readFile(join(repository, ".build/desktop/package-attestation.json"), "utf8"),
);
if (
  evidence.platform !== process.platform ||
  evidence.arch !== process.arch ||
  evidence.paths.length !== 1
)
  throw new Error("Package this platform before creating its distribution files.");
const source = join(
  repository,
  `.build/desktop/packages/Embassys-${process.platform}-${process.arch}`,
);
if (evidence.paths[0] !== source)
  throw new Error("The package location is not the expected build output.");
const directory = join(repository, ".build/desktop/distribution");
await mkdir(directory, { recursive: true });
const stem = `Embassys-${evidence.manifest.app}-${process.platform}-${process.arch}-development`;
const extension =
  process.platform === "darwin" ? "dmg" : process.platform === "win32" ? "zip" : "tar.gz";
const archive = join(directory, `${stem}.${extension}`);
await verifyInventory(source, evidence.inventory);
const files = evidence.inventory;
const run = runArchiveTool;
for (const path of [
  archive,
  ...["manifest.json", "cdx.json", "sha256"].map((suffix) => join(directory, `${stem}.${suffix}`)),
])
  await rm(path, { force: true });
try {
  if (process.platform === "darwin") {
    await run("/usr/bin/hdiutil", [
      "create",
      "-verbose",
      "-fs",
      "HFS+",
      "-format",
      "UDZO",
      "-volname",
      "Embassys",
      "-srcfolder",
      source,
      archive,
    ]);
    await run("/usr/bin/hdiutil", ["verify", "-verbose", archive]);
  } else {
    await run(process.platform === "win32" ? "tar.exe" : "tar", [
      process.platform === "win32" ? "-acf" : "-czf",
      archive,
      "-C",
      dirname(source),
      basename(source),
    ]);
  }
  await verifyInventory(source, files);
  const bom = await dependencyBom(source, files, evidence.manifest);
  const record = {
    schema: 1,
    artifact: basename(archive),
    sha256: await sha256(archive),
    applicationCodeSigned: evidence.signed,
    macAdHocSigned: evidence.adHocSigned === true,
    archiveSigned: false,
    build: evidence.manifest,
    inventory: files,
  };
  await writeFile(join(directory, `${stem}.manifest.json`), JSON.stringify(record, null, 2));
  await writeFile(join(directory, `${stem}.cdx.json`), JSON.stringify(bom, null, 2));
  await writeFile(join(directory, `${stem}.sha256`), `${record.sha256}  ${basename(archive)}\n`);
  console.log(`Development distribution ready: ${archive}`);
  console.log(
    "Includes a SHA-256 checksum, exact file inventory and CycloneDX dependency list. Nothing was published.",
  );
} catch (error) {
  await rm(archive, { force: true });
  throw error;
}
