import { rm } from "node:fs/promises";

const paths = process.argv.slice(2);
const targets = paths.length > 0 ? paths : ["dist", ".test-dist"];

await Promise.all(targets.map((path) => rm(path, { force: true, recursive: true })));
