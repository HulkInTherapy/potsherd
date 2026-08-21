#!/bin/sh
# usage: R=<kept eval index> sh phases/phase-3/evidence-t31/sweep.sh
# Robustness check, not a tuning loop: is the result a plateau or a knife edge?
for w in 1.0 1.2 1.5 2.0 3.0; do
  W="{\"vec_exchanges\":$w,\"vec_cards\":$w,\"vec_ghost_prompts\":$w}" \
    npx tsx phases/phase-3/evidence-t31/sweep.ts 2>&1 | grep -v "npm warn"
done
for c in 0.05 0.12 0.25 0.5; do
  C=$c npx tsx phases/phase-3/evidence-t31/sweep.ts 2>&1 | grep -v "npm warn"
done
