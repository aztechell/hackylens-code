# HackyLens Code

This production site was built from the standalone HackyLens Code repository.
The source tree includes the HackyLens HMPY v1 Web Serial transport, UI and
tests, together with the pinned Pybricks Code base described in
`HACKYLENS_UPSTREAM.json`.

Serve the build over HTTPS or localhost. Web Serial is not available when the
site is opened directly from `file://`.

Connect a SEN0305 or Maix Cube with camera-enabled HackyLens firmware.
Open **Камера** in the toolbar while the board is at its main menu or showing
a native camera preview. **Превью** fetches small frames over the serial
connection. **Снимок** takes a higher-resolution frame, and **Скачать PNG**
saves the frame currently shown.
