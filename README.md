# HackyLens Code

HackyLens Code is the standalone browser IDE for the HackyLens firmware. It
provides a Monaco editor, Web Serial transport, atomic script upload and file
management, startup selection, run/stop/status controls, and live stdout/stderr
over HMPY v1.

The IDE supports HUSKYLENS SEN0305 and Sipeed Maix Cube with HackyLens
firmware. Connect via USB and select the board's serial port. The IDE identifies
the board from its HMPY reply and displays its screen size. Maix Cube can expose
two USB serial ports with the same name. If one times out, select the other.

This repository contains the complete buildable source tree. It is derived from
[Pybricks Code](https://github.com/pybricks/pybricks-code) at the pinned revision
recorded in [`HACKYLENS_UPSTREAM.json`](HACKYLENS_UPSTREAM.json), with the
HackyLens-specific entrypoint, transport, UI, tests, and build configuration
applied directly. See [`HACKYLENS_NOTICE.md`](HACKYLENS_NOTICE.md),
[`LICENSE`](LICENSE), and [`UPSTREAM_README.md`](UPSTREAM_README.md) for
provenance and attribution.

## Requirements

- Node.js 24, as used by CI
- Chrome or Edge with Web Serial support
- A secure browser context; `localhost` is accepted, deployed builds require
  HTTPS

## Install and run

```powershell
node .yarn\releases\yarn-3.3.0.cjs install --immutable
node .yarn\releases\yarn-3.3.0.cjs start
```

Open <http://localhost:4173>.

## Test and build

```powershell
node .yarn\releases\yarn-3.3.0.cjs typecheck
node .yarn\releases\yarn-3.3.0.cjs test
node .yarn\releases\yarn-3.3.0.cjs build
```

The production static site is written to `build/`. Serve that directory over
HTTPS or localhost; opening `index.html` directly does not provide a valid Web
Serial context.

## Main HackyLens files

- `src/hackylens/` — HMPY codec/client, safe Web Serial transport and UI
- `config/webpack.hackylens.js` — focused production/development bundle
- `config/jest.hackylens.js` — HackyLens test suite
- `scripts/hackylens-start.js` and `scripts/hackylens-build.js` — entrypoints
- `docs/HMPY_PROTOCOL.md` — protocol contract mirrored from the firmware repo

Large upstream LEGO firmware binaries and instructional videos are intentionally
omitted because the HackyLens entrypoint cannot reach them. The exact omission
profile is recorded in `HACKYLENS_UPSTREAM.json`.

The previous firmware-repository overlay and bootstrap script are preserved
read-only under `migration/from-firmware-repo/` as migration evidence. The
canonical editable implementation is the standalone root source tree.
