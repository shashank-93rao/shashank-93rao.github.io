# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a personal blog built with **Astro** (the [AstroPaper](https://github.com/satnaing/astro-paper) theme) and hosted on GitHub Pages at `https://shashank-93rao.github.io/`. It was migrated from Hugo in September 2026. Deployment is via GitHub Actions (`.github/workflows/deploy.yml`), which builds and publishes on every push to `main` — there's no manual build/copy step and no `docs/` directory anymore.

## Commands

**Local development:**
```bash
npm run dev
```

**Build (also generates the Pagefind search index):**
```bash
npm run build
```

**Preview a production build locally:**
```bash
npm run preview
```

**Create a new draft post:**
```bash
npm run new:post -- "My Post Title"
```
Scaffolds `src/content/posts/<slug>.md` with `draft: true`.

**Create a new "papers I've read" entry:**
```bash
npm run new:paper -- "Paper Title"
```
Scaffolds `src/content/papers/<slug>.md`.

**Sync posts from an Obsidian vault:**
```bash
source .venv/bin/activate
python obsidian-hugo.py <obsidian-vault-path> <content-path> <static-path>
```
Note: this script still emits Hugo-style `{{< ref "..." >}}` shortcodes for `[[wikilinks]]`, which Astro/Markdown doesn't understand — it needs updating (to emit plain relative links, e.g. `/posts/slug/`) before being used again post-migration.

## Architecture

```
src/
  content/posts/   # Blog posts (Markdown/MDX with YAML frontmatter, content-collection schema in content.config.ts)
  content/papers/  # "Papers I've read" entries (title, authors, link, description)
  content/pages/   # Standalone pages (About)
  pages/           # Astro routes: index, posts/[...slug], papers/, tags/, archives/, search/
  components/      # Shared Astro components (Header, Footer, Card, Tag, SeriesNav, etc.)
  layouts/         # Page/post layout shells
  styles/          # theme.css (color scheme tokens), typography.css, global.css
public/            # Static assets served as-is, e.g. /images/*
astro.config.ts        # Astro build config (integrations, Shiki, fonts)
astro-paper.config.ts  # Site metadata, features, socials (site title, author, search provider, etc.)
```

## Content Conventions

Post frontmatter:
```yaml
---
title: Post Title
pubDatetime: 2026-04-25T20:08:01+05:30
draft: false
tags:
  - tag1
description: One-sentence summary (required, used in SEO/RSS).
---
```

Optional `series: <series-name>` + `order: <n>` fields group related posts and render a `SeriesNav` on each post in that series (see the `consensus-algorithms` series: consensus, paxos, multi-paxos, raft).

Images go in `public/images/` and are referenced as `/images/filename.png` in Markdown.

Papers frontmatter:
```yaml
---
title: Paper Title
authors: "Author names"
link: "https://drive.google.com/..."
description: One-line summary
---
```
The `/papers` index links each title directly to its `link` (opens the PDF) — there's no separate per-paper detail page, so body content isn't rendered anywhere.

## Theme & Color Scheme

Color tokens live in `src/styles/theme.css` (light: "Pyit Tine Htaung" warm/cream scheme; dark: "Espresso"). Code highlighting uses Shiki with `catppuccin-latte`/`catppuccin-mocha` (configured in `astro.config.ts`), and headings use a serif font (`Lora`, registered as `--font-serif`).

## Search

Fuse.js/Pagefind (via `astro-paper.config.ts`'s `features.search: "pagefind"`) is built into `npm run build` — no separate indexing step needed.

## Deployment

Push to `main` triggers `.github/workflows/deploy.yml`, which builds and deploys via `actions/deploy-pages`. GitHub repo Settings → Pages → Source must be set to **GitHub Actions** (not a branch) for this to work.

## Documentation

Full Astro documentation: https://docs.astro.build

Consult these guides before working on related tasks:
- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
