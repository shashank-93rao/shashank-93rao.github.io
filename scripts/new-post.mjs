#!/usr/bin/env node
// Scaffolds a new draft post at src/content/posts/<slug>.md
// Usage: npm run new:post -- "My Post Title"

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const title = process.argv.slice(2).join(" ").trim();

if (!title) {
  console.error('Usage: npm run new:post -- "My Post Title"');
  process.exit(1);
}

const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/(^-|-$)/g, "");

const postsDir = join(__dirname, "..", "src", "content", "posts");
mkdirSync(postsDir, { recursive: true });

const filePath = join(postsDir, `${slug}.md`);
if (existsSync(filePath)) {
  console.error(`Post already exists: ${filePath}`);
  process.exit(1);
}

const pubDatetime = new Date().toISOString();

const frontmatter = `---
title: ${title}
pubDatetime: ${pubDatetime}
draft: true
tags: []
description: ""
---

`;

writeFileSync(filePath, frontmatter);
console.log(`Created ${filePath}`);
