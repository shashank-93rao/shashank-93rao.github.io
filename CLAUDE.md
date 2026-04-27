# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a personal blog/portfolio site built with **Hugo** and hosted on GitHub Pages at `https://shashank-93rao.github.io/`. The Hugo source lives in `shashank/` and the built output is served from `docs/`.

## Commands

**Local development (live reload):**
```bash
cd shashank && hugo server
```

**Build and publish:**
```bash
./publish.sh
```
This wipes `docs/`, runs `hugo` in `shashank/`, and copies the output to `docs/` (which GitHub Pages serves from).

**Create a new post:**
```bash
./newcontent.sh my-post-title
```
New posts default to `draft: true` — set `draft: "false"` to publish.

**Sync posts from an Obsidian vault:**
```bash
source .venv/bin/activate
python obsidian-hugo.py <obsidian-vault-path> shashank/content shashank/static
```

## Architecture

```
shashank/          # Hugo site source
  content/posts/   # Blog posts (Markdown with YAML frontmatter)
  content/about/   # About page
  static/images/   # Images referenced in posts
  themes/mini/     # Hugo theme (git submodule: nodejh/hugo-theme-mini)
  hugo.yaml        # Hugo config (baseURL, theme, social links)
  public/          # Hugo build output (gitignored, intermediate)
docs/              # Final published output served by GitHub Pages
obsidian-hugo.py   # Converts Obsidian wikilinks/image syntax to Hugo-compatible Markdown
```

## Content Conventions

Post frontmatter:
```yaml
---
title: Post Title
date: 2026-04-25T20:08:01+05:30
draft: "false"
tags:
  - tag1
---
```

Images go in `shashank/static/images/` and are referenced as `/images/filename.png` in Markdown.

## Deployment

Publishing is manual — run `./publish.sh`, then commit and push. GitHub Pages serves from the `docs/` directory on `main`.
