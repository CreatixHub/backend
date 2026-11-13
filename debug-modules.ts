import { readdirSync } from "node:fs";

const files = ["src/db/index.ts", "src/lib/logger.ts"];
for (const m of readdirSync("src/modules")) {
  for (const f of readdirSync(`src/modules/${m}`)) {
    if (f.endsWith(".routes.ts")) files.push(`src/modules/${m}/${f}`);
  }
}

(async () => {
  for (const f of files) {
    console.log("loading", f);
    try {
      await import("./" + f);
      console.log("   ok");
    } catch (e) {
      console.log("   FAILED", e);
    }
  }
  console.log("done");
})();