const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function files(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .flatMap((item) =>
      item.isDirectory()
        ? files(path.join(folder, item.name))
        : [path.join(folder, item.name)],
    );
}
for (const file of files(path.join(root, "src"))) {
  if (!file.endsWith(".js"))
    throw new Error("Unexpected non-JavaScript source: " + file);
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}
console.log("JavaScript syntax checks passed.");
