import { basename, relative, sep } from "node:path";

export function testOptions(args) {
  const options = { suite: "all", coverage: false, list: false };
  let selected = false;
  for (const arg of args) {
    if (arg === "--coverage") options.coverage = true;
    else if (arg === "--list") options.list = true;
    else if (arg.startsWith("--suite=") && !selected) {
      options.suite = arg.slice("--suite=".length);
      selected = true;
    } else throw new Error(`Unknown or repeated test option: ${arg}`);
  }
  if (!["all", "core", "platform"].includes(options.suite)) {
    throw new Error(`Unknown test suite: ${options.suite}`);
  }
  return options;
}

export function selectTests(root, files, suite) {
  testOptions([`--suite=${suite}`]);
  const selected = files
    .filter((file) => {
      const path = relative(root, file);
      if (path === ".." || path.startsWith(`..${sep}`)) throw new Error("Test outside root");
      if (!file.endsWith(".test.js") || basename(file).startsWith("t03-")) return false;
      const platform = path.split(sep)[0] === "platform";
      return suite === "all" || (suite === "platform" ? platform : !platform);
    })
    .sort();
  if (!selected.length) throw new Error(`No compiled tests in ${suite} suite under ${root}`);
  return selected;
}
