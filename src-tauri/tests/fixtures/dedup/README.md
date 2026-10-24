# Cover comparison regression fixtures

The six 64×96 PNGs are cover-only crops from the three user-supplied screenshots
reported on 2026-10-23. Titles, tags and archive identifiers are excluded.
Each numbered `a`/`b` pair is **not** a duplicate:

- 1: unrelated artwork on similar pale backgrounds.
- 2: similar figure placement with different illustration/detail and colour.
- 3: different volumes using shared series artwork but different cover colours.

Rust tests decode these via the production signature generator. They also verify
that resizing and JPEG compression of each individual cover still match itself.
These are reduced screenshot crops, not original cover files; they are regression
examples, not a representative precision/recall benchmark.
