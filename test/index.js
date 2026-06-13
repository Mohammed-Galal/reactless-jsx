const compile = require("../src/standalone.js");
const fs = require("fs");

const src = fs.readFileSync(__dirname + "/fixture.jsx", "utf-8");
const out = compile(src, { filename: "fixture.jsx" });

// Quick sanity check: no JSX leftovers
if (out.includes("<div>") || out.includes("</div>")) {
  console.error("❌ JSX elements leaked into output");
  process.exit(1);
}
console.log("✅ Standalone compilation works");

// Also test Babel plugin integration (requires @babel/core)
const babel = require("@babel/core");
try {
  const result = babel.transformSync(src, {
    plugins: [require("../src/babel-plugin.js")],
    filename: "fixture.jsx",
  });
  if (result.code.includes("<div>")) {
    console.error("❌ Babel plugin left JSX");
    process.exit(1);
  }
  console.log("✅ Babel plugin works");
} catch (e) {
  console.error("❌ Babel plugin test failed:", e.message);
  process.exit(1);
}
