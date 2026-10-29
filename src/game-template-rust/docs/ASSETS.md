# Assets

This game's asset ledger: one line per model it draws that was sourced (fetched or generated),
naming the draw tag it is drawn under and its file under `assets/`. Each line is a list item of
the tag, a colon and the file, for example a line reading `- bench: cc0/<job>/painted_wooden_bench_2k.glb`.
Whoever sources a model adds its line in the same change that delivers the file. The harness's
sourcing stage holds builders until every model the plan names has a line here, and its provenance
check compares each line with the planned source: a box script delivered where a model was
planned is a defect.

