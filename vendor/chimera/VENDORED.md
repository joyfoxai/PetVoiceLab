# Vendored: CHIMERA engine crate

- Source: https://github.com/jamesondh/chimera-vocal-synth, `crates/chimera/`
- Commit: `6259e880f5d0108b862e98cefd930aa8c5bc0dc5`
- Licence: MIT, Copyright (c) 2026 Jameson Hodge (see `LICENSE` in this folder)
- Changes: none to `src/` or `Cargo.toml`. `tests/` and `examples/` were left out (6 MB of
  golden fixtures that test CHIMERA's own voice, not ours).

PetVoice Lab uses from it: `airway::network` (the FDTD airway), `airway::decimator`,
`creatures::mammal` and `creatures::build` (the mammal airway topology and tube helpers),
`sources::glottis` (the parametric glottal-area source), `math`, `physics`.

To update: replace `src/` and `Cargo.toml` from a newer commit, run `npm test`, and re-listen:
any change to CHIMERA's airway or glottis changes every pet's voice.
