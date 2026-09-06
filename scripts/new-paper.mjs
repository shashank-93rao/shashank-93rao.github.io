#!/usr/bin/env node
// Scaffolds a new "papers I've read" entry at src/content/papers/<slug>.md
// Usage: npm run new:paper -- "Paper Title"

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const title = process.argv.slice(2).join(" ").trim();

if (!title) {
  console.error('Usage: npm run new:paper -- "Paper Title"');
  process.exit(1);
}

const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/(^-|-$)/g, "");

const papersDir = join(__dirname, "..", "src", "content", "papers");
mkdirSync(papersDir, { recursive: true });

const filePath = join(papersDir, `${slug}.md`);
if (existsSync(filePath)) {
  console.error(`Paper entry already exists: ${filePath}`);
  process.exit(1);
}

const frontmatter = `---
title: ${title}
authors: ""
link: ""
description: ""
---

`;

writeFileSync(filePath, frontmatter);
console.log(`Created ${filePath}`);
