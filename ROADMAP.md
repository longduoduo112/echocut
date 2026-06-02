# Roadmap / 路线图

echocut is **actively maintained**. This is a living document of direction, not a
promise of dates. Ideas and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

> 这是方向性的路线图,不承诺具体时间。欢迎在 issue 里提想法、提 PR。

## Shipped / 已落地

- One-command `burn` pipeline: transcribe → subtitles → title → brand band → cover → publish kit
- `highlights` two-phase flow (`hls` analyze → `hmk` render) with disk cache + resume
- Layout modes: vertical / landscape / square / 4:3, plus `--obs` and `--auto-pad`/`--strip-top`
- Multi-brand system (one JSON per brand) — content overrides, layout stays consistent
- ASR engines with strict no-silent-downgrade ([docs/ASR-ENGINES.md](docs/ASR-ENGINES.md))
- Marketing toolkit: `distribute`, `hook-gen`, `cover`, `cross-lang`
- CI (Node 18/20), bilingual docs, troubleshooting & FAQ

## Near-term / 近期

- [ ] **Smoother first run** — a tiny sample clip / `hello world` so a new user sees output before supplying their own footage
- [ ] **Wider Windows/Linux validation** — confirm the WhisperX path end-to-end on more setups; document GPU/CUDA tips
- [ ] **More brand examples** — a couple of ready-to-copy `configs/brands/*.json` styles
- [ ] **Better error messages** — turn common failures into actionable hints in `echocut doctor`

## Exploring / 探索中

- [ ] **Desktop app** — an Electron/Tauri shell over the CLI engine with automatic CPU/GPU detection, for non-terminal users
- [ ] **Pluggable providers** — make the LLM / TTS / image backends swappable behind a thin client layer
- [ ] **Benchmark subcommand** — a repeatable scoring rubric for short-form output quality

## How to help / 怎么参与

- 🐛 Found a bug? Open an issue with the failing command + `echocut doctor` output + your OS.
- 💡 Want a feature? Open an issue describing the workflow — concrete use cases shape priorities.
- 🛠️ Sending a PR? Keep `npm run check` + `npm run test:unit` green and respect the
  "brand overrides content, not layout" rule (see [CLAUDE.md](CLAUDE.md)).
