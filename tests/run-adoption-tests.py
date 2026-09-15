#!/usr/bin/env python3
import re
from pathlib import Path
import yaml
ROOT=Path(__file__).resolve().parents[1]
proposal=yaml.safe_load((ROOT/"specforge/changes/CHG-0001/PROP-0001-01.yaml").read_text())
manifest=yaml.safe_load((ROOT/"specforge/project.yaml").read_text())
adoption_evidence=yaml.safe_load((ROOT/"specforge/evidence/migrations/legacy-root-v1/specforge.yaml.before.yaml").read_text())
assert manifest["project"]["name"]=="Batty Joe"
assert re.match(r"^\d+\.\d+\.\d+$", manifest["specification"]["current_version"])
assert (ROOT/manifest["specification"]["product_specification"]).resolve().exists()
for rel in proposal["baseline_artifact_hashes"]:
    assert (ROOT/rel).exists(), rel
assert adoption_evidence["adoption"]["mode"]=="existing_project_baseline"
assert adoption_evidence["adoption"]["historical_forensic_reconstruction"]=="not_permitted_without_evidence"
assert "CHG-0001" in [p.stem for p in sorted((ROOT/"specforge/changes").glob("CHG-*.yaml"))]
print("Batty Joe adoption tests PASSED")
