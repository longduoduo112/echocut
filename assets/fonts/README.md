# Fonts

ECHOCUT uses **Noto Sans SC** (SIL Open Font License 1.1) as the default CJK font for
burned-in subtitles, titles and covers. The font is **not bundled** in the repo — run:

```bash
npm run fetch-fonts        # downloads Noto Sans SC into this folder (OFL.txt included)
```

Want a different font? Drop any `.ttf/.otf` here and point your brand/config at it.
