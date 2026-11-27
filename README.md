[![png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Boyoke-Encok/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Boyoke-Encok/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

# PNG Squeeze — Smallest Lossless PNG for Screenshots

An entry for the [png-squeeze-01-run-20261127 bounty](https://make.fun/bounty/png-squeeze-01-run-20261127)
on make.fun. One program (`main.ts`, Node 22, built-ins only) answers a set of
8 screenshots (1280×720 RGBA) in a single run, rewriting each one losslessly
in as few bytes as it can.

How it squeezes:

- Decodes the stored input PNG and analyses each image: flat-colour images
  (≤ 256 colours) become palette PNGs, grey images become grey/grey+alpha,
  opaque images drop the alpha channel to RGB.
- Per-row adaptive filter choice (None / Sub / Up / Average / Paeth) by
  minimum-cost heuristics, trying several filter strategies per image.
- Compresses with zlib level 9 (default and filtered strategies), keeping the
  smallest output. Fully deterministic: two runs write byte-identical files.

Practice-set score (kit `grade-local`, process driver): **698,225**, vs the
house baseline fixed-paeth 1.0.0 at 420,399 — all 8 instances answered, in
about 12 seconds for the whole set.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
