# Historical Stack Pins

`pins.toml` and `repin.py` preserve the pre-consolidation Cargo and Pekit
coordination workflow. Their revisions and package constraints describe
that historical stack, including its PKM source. They are not inputs to
the Bazel build or the active development push.

Do not run the repinning script against migrated repositories. It rewrites
manifests, packaging constraints, and lockfiles for the historical layout.
The exact pre-migration copies are retained in the migration evidence
archive. The relocated script resolves sibling roots from its adjusted
location; its dependency pins retain their recorded values.

Use [Building GXWI](../../docs/building.md) for the maintained build and
[Development Qualification](../../docs/development.md) for test scope.
