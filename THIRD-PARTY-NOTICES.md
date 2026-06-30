# Third-Party Notices

Klonkt is licensed under **AGPL-3.0-or-later** (see [LICENSE](LICENSE)). It is built on the
open-source software listed below, with gratitude. Each dependency's own licence text is retained in
`node_modules/<package>/` after `npm install`; this file is a summary and acknowledgement.

## Runtime dependencies (npm)

| Package(s) | Licence |
|---|---|
| express · express-session · body-parser · multer · express-rate-limit · helmet · bcryptjs · better-sqlite3 · marked · sanitize-html · uuid · fluent-ffmpeg | MIT |
| nodemailer | MIT-0 |
| dotenv | BSD-2-Clause |
| htmx.org | 0BSD |
| ejs | Apache-2.0 |
| @resvg/resvg-js | MPL-2.0 |
| node-webpmux | LGPL-3.0-or-later |
| ffmpeg-static | GPL-3.0-or-later |

## Bundled binaries & native libraries

These packages ship pre-built native components, redistributed under their own licences:

- **FFmpeg** — bundled via [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static), licensed
  **GPL-3.0-or-later**. Source: <https://ffmpeg.org/>. Used to transcode audio and build the
  looping video covers.
- **libwebp** — bundled via [`node-webpmux`](https://github.com/ApeironTsuka/node-webpmux)
  (LGPL-3.0-or-later); libwebp itself is BSD-3-Clause (© Google Inc.). Used to decode animated WebP
  covers.
- **resvg** — bundled via [`@resvg/resvg-js`](https://github.com/yisibl/resvg-js) (MPL-2.0). Used to
  render the Open Graph preview cards.
- **SQLite** — bundled via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (MIT);
  SQLite itself is public domain. The database engine.

## Fonts

Bundled in `src/assets/fonts/`, all under the **SIL Open Font License 1.1** (full text in
`src/assets/fonts/OFL.txt`):

- **Fraunces** — © The Fraunces Project Authors (<https://github.com/undercasetype/Fraunces>).
- **Plus Jakarta Sans** — © The Plus Jakarta Sans Project Authors
  (<https://github.com/tokotype/PlusJakartaSans>).
- **Literata** — © The Literata Project Authors.

---

If you redistribute Klonkt, please keep this file and the bundled licence texts intact.
