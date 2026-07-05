# Cover Background Drafts

These PNG files are reusable no-text background drafts for VibePub WeChat covers.

Normal mining chooses from `templates.json` and then uses the deterministic
SVG/Sharp title treatment. It should not call an image model per article.

To generate a new draft manually:

```bash
cd infra/mining
GPT_IMAGE_BASE_URL=<openai-compatible-image-base-url> \
npm run generate:cover-background -- --id warm-editorial-desk-v2
```

The script asks for `GPT_IMAGE_API_KEY` when it is not already set. After
reviewing the generated PNG, add or update its entry in `templates.json`.
