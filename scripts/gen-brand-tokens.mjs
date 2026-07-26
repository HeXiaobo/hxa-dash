#!/usr/bin/env node
/**
 * Generate the dashboard's brand token artifacts from the canonical Three AI
 * DESIGN.md YAML front matter.
 *
 * Usage:
 *   node scripts/gen-brand-tokens.mjs /path/to/knowledge-base/brand/DESIGN.md
 *   node scripts/gen-brand-tokens.mjs --check /path/to/knowledge-base/brand/DESIGN.md
 *
 * The generated files are committed so production never depends on access to
 * the private knowledge-base repository.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SOURCE_BLOB = '5950bdbe591426d43ebd6262c3757582a4ca1ab6';
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const explicitSource = args.find(arg => !arg.startsWith('--'));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const sourceCandidates = [
  explicitSource,
  process.env.THREE_AI_DESIGN_PATH,
  path.resolve(repoRoot, '..', 'knowledge-base', 'brand', 'DESIGN.md'),
  '/home/cocoai/zylos/workspace/knowledge-base/brand/DESIGN.md',
].filter(Boolean);
const sourcePath = sourceCandidates.find(candidate => fs.existsSync(candidate));

if (!sourcePath) {
  console.error(
    'Canonical brand source not found. Pass /path/to/knowledge-base/brand/DESIGN.md ' +
    'or set THREE_AI_DESIGN_PATH.'
  );
  process.exit(1);
}

const raw = fs.readFileSync(sourcePath, 'utf8');
const frontMatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!frontMatter) {
  console.error(`No YAML front matter found in ${sourcePath}`);
  process.exit(1);
}

const tokens = { colors: {}, rounded: {}, spacing: {}, typography: {} };
let section = null;
let scale = null;
for (const line of frontMatter[1].split(/\r?\n/)) {
  if (/^\s*#/.test(line)) continue;
  const sectionMatch = line.match(/^([A-Za-z][\w-]*):\s*$/);
  if (sectionMatch) {
    section = sectionMatch[1];
    scale = null;
    continue;
  }
  if (['colors', 'rounded', 'spacing'].includes(section)) {
    const valueMatch = line.match(/^  ([\w-]+):\s*"?([^"]+?)"?\s*$/);
    if (valueMatch) tokens[section][valueMatch[1]] = valueMatch[2].trim();
    continue;
  }
  if (section === 'typography') {
    const scaleMatch = line.match(/^  ([\w-]+):\s*$/);
    if (scaleMatch) {
      scale = scaleMatch[1];
      tokens.typography[scale] = {};
      continue;
    }
    const propertyMatch = line.match(/^    ([\w-]+):\s*"?([^"]+?)"?\s*$/);
    if (propertyMatch && scale) {
      tokens.typography[scale][propertyMatch[1]] = propertyMatch[2].trim();
    }
  }
}

const shadow = {
  standard: '0 22px 55px rgb(15 23 42 / 0.08)',
  brand: '0 14px 34px rgb(15 23 42 / 0.05)',
};
const contentWidth = 'min(1180px, calc(100% - 32px))';
const family = tokens.typography.body?.fontFamily
  || 'Inter, PingFang SC, Microsoft YaHei, sans-serif';

let css = `/* AUTO-GENERATED from with3ai/knowledge-base/brand/DESIGN.md.
 * Canonical blob: ${SOURCE_BLOB}
 * Regenerate with scripts/gen-brand-tokens.mjs. Do not hand-edit. */
:root {
  /* Colors: 90% neutral + 10% Jade Ink. */
`;
for (const [key, value] of Object.entries(tokens.colors)) {
  css += `  --color-${key}: ${value};\n`;
}
css += '\n  /* Radius. */\n';
for (const [key, value] of Object.entries(tokens.rounded)) {
  css += `  --radius-${key}: ${value};\n`;
}
css += '\n  /* Spacing. */\n';
for (const [key, value] of Object.entries(tokens.spacing)) {
  css += `  --space-${key}: ${value};\n`;
}
css += `\n  /* Typography. */
  --font-sans: ${family};
`;
for (const [key, values] of Object.entries(tokens.typography)) {
  if (values.fontSize) css += `  --fs-${key}: ${values.fontSize};\n`;
  if (values.fontWeight) css += `  --fw-${key}: ${values.fontWeight};\n`;
  if (values.lineHeight) css += `  --lh-${key}: ${values.lineHeight};\n`;
}
css += `
  /* Elevation is reserved for real hierarchy. */
  --shadow-standard: ${shadow.standard};
  --shadow-brand: ${shadow.brand};

  /* Layout. */
  --content-width: ${contentWidth};
}
`;

const json = `${JSON.stringify({
  _source: 'with3ai/knowledge-base/brand/DESIGN.md',
  _sourceBlob: SOURCE_BLOB,
  _generatedBy: 'scripts/gen-brand-tokens.mjs',
  colors: tokens.colors,
  rounded: tokens.rounded,
  spacing: tokens.spacing,
  typography: tokens.typography,
  shadow,
  contentWidth,
}, null, 2)}\n`;

const outputs = [
  [path.join(repoRoot, 'public', 'css', 'brand-tokens.css'), css],
  [path.join(repoRoot, 'public', 'assets', 'brand', 'brand-tokens.json'), json],
];

let mismatch = false;
for (const [outputPath, content] of outputs) {
  if (checkOnly) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
    if (current !== content) {
      mismatch = true;
      console.error(`OUTDATED: ${path.relative(repoRoot, outputPath)}`);
    }
  } else {
    fs.writeFileSync(outputPath, content);
    console.log(`wrote ${path.relative(repoRoot, outputPath)}`);
  }
}

if (checkOnly && mismatch) process.exit(1);
if (checkOnly) console.log('brand token artifacts match the canonical source');
