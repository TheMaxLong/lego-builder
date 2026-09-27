# Lego Builder

A Mac app for building your own brick creations in 3D, CAD-style: orbit the model, click
bricks onto studs, and keep everything on your own disk.

- The whole [LDraw](https://www.ldraw.org) parts library: 20,000+ real parts, searchable, with thumbnails
- Snap-to-stud placement with a see-through preview, turning, tilting, multi-select, copy/paste, mirror
- Paint mode, hide/isolate, undo/redo, autosave with version history
- Preset catalogs (town, nature, castle, space, interiors) and a browser for official Lego set models
- Minifigure builder
- Display table: put your saved creations out on a table or shelves and look at them together
- High-res pictures, turntable videos, and a build replay of any model

Creations are saved as standard `.ldr` files in `~/Documents/Lego Builder`, so any
LDraw-compatible program can open them.

## Build

Needs Rust, the Tauri CLI (`cargo install tauri-cli --version "^2"`), and Xcode command-line tools.

```sh
tools/vendor-three.sh          # fetch the pinned three.js files
cargo tauri build              # -> src-tauri/target/release/bundle/macos/Lego Builder.app
```

On first launch the app downloads the LDraw parts library (about 145 MB) into
`~/Library/Application Support/LegoBuilder`.

For development in a normal browser: `node tools/devserver.mjs` and open http://127.0.0.1:5173.
Tests: `node --test tests/*.test.mjs` and `cd src-tauri && cargo test`.

## Credits

Parts geometry from the LDraw Parts Library, licensed CC BY 4.0 by the LDraw contributors.
3D rendering by three.js.

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project.
