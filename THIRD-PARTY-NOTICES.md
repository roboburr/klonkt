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

## Vendored browser libraries

Checked into `src/assets/` rather than pulled from a CDN: the Content-Security-Policy allows
scripts from `'self'` only, so anything the browser runs has to ship with Klonkt. Each file keeps
the licence header its author put there; Lenis ships its licence as a separate file because its
build has no header.

| Library | Version | Licence | Where |
|---|---|---|---|
| [Lenis](https://github.com/darkroomengineering/lenis) + `lenis/snap` | 1.3.26 | MIT (© darkroom.engineering) — text in `src/assets/vendor/lenis-LICENSE.txt` | `src/assets/vendor/lenis*.mjs` |
| [Cropper.js](https://github.com/fengyuanchen/cropperjs) | 1.6.2 | MIT (© Chen Fengyuan) — header in the file | `src/assets/vendor/cropper.min.*` |
| [@simplewebauthn/browser](https://github.com/MasterKale/SimpleWebAuthn) | 13.3.0 | MIT | `src/assets/vendor/simplewebauthn-browser.umd.min.js` |
| [htmx](https://htmx.org) | — | 0BSD (also listed under npm above) | `src/assets/js/htmx.min.js` |

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
