#!/usr/bin/env python3
from pathlib import Path
import hashlib, yaml
ROOT=Path(__file__).resolve().parents[1]
proposal=yaml.safe_load((ROOT/"changes/CHG-0001/PROP-0001-01.yaml").read_text())
manifest=yaml.safe_load((ROOT/"specforge.yaml").read_text())
assert manifest["project"]["name"]=="Batty Joe"
assert manifest["specification"]["current_version"]=="1.5.0"
assert (ROOT/manifest["specification"]["product_specification"]).resolve().exists()
for rel, expected in proposal["baseline_artifact_hashes"].items():
    assert hashlib.sha256((ROOT/rel).read_bytes()).hexdigest()==expected, rel
assert manifest["adoption"]["mode"]=="existing_project_baseline"
assert manifest["adoption"]["historical_forensic_reconstruction"]=="not_permitted_without_evidence"
assert [p.stem for p in sorted((ROOT/"changes").glob("CHG-*.yaml"))]==["CHG-0001"]
print("Batty Joe adoption tests PASSED")
