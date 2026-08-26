// Build a single, portable HTML file by inlining styles.css and app.js.
// Usage: node build.mjs  ->  produces vocab-trainer.html
import fs from "node:fs";

const dir = new URL("./", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, dir), "utf8");

let html = read("index.html");
const css = read("styles.css");
const js = read("app.js");
const samples = read("samples.js");
const corpus = read("corpus.js");
const grammar = read("grammar.js");

// Guard against an accidental </script> inside the JS breaking the inline block.
const safeJs = js.replace(/<\/script>/gi, "<\\/script>");
const safeSamples = samples.replace(/<\/script>/gi, "<\\/script>");
const safeCorpus = corpus.replace(/<\/script>/gi, "<\\/script>");
const safeGrammar = grammar.replace(/<\/script>/gi, "<\\/script>");

// Use function replacers so `$` sequences in the CSS/JS (e.g. the $$ helper)
// are inserted literally rather than interpreted as replacement patterns.
html = html.replace(
  '<link rel="stylesheet" href="styles.css" />',
  () => `<style>\n${css}\n</style>`
);
html = html.replace(
  '<script src="corpus.js"></script>',
  () => `<script>\n${safeCorpus}\n</script>`
);
html = html.replace(
  '<script src="grammar.js"></script>',
  () => `<script>\n${safeGrammar}\n</script>`
);
html = html.replace(
  '<script src="samples.js"></script>',
  () => `<script>\n${safeSamples}\n</script>`
);
html = html.replace(
  '<script src="app.js"></script>',
  () => `<script>\n${safeJs}\n</script>`
);

if (
  html.includes('href="styles.css"') ||
  html.includes('src="app.js"') ||
  html.includes('src="samples.js"') ||
  html.includes('src="corpus.js"') ||
  html.includes('src="grammar.js"')
) {
  console.error("WARNING: an asset reference was not inlined; check the placeholders in index.html");
  process.exit(1);
}

const outName = "vocab-trainer.html";
fs.writeFileSync(new URL(outName, dir), html);
console.log(`Built ${outName} (${(html.length / 1024).toFixed(1)} KB) — open it directly in a browser.`);
