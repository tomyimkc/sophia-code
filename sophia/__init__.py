# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Public package surface for Sophia AGI.

Sophia is packaged as verifier-gated AGI-candidate training/proof machinery,
not as a claim that AGI has been achieved.
"""

from sophia.trainer import (
    CommandSpec,
    ExperimentConfig,
    build_experiment_plan,
    load_experiment_config,
)

# Must equal the root VERSION file: pyproject declares
# `dynamic = ["version"]` with `version = {file = "VERSION"}`, so an installed
# sophia-agi reports VERSION while this literal reported something else — and
# `sophia --version` prints THIS one. Enforced by
# tools/check_version_consistency.py, which previously covered pyproject,
# both package.json files and version.ts but not this module, which is how it
# drifted to 0.9.0 while the product shipped 0.12.0.
__version__ = "0.12.16"

__all__ = [
    "__version__",
    "CommandSpec",
    "ExperimentConfig",
    "build_experiment_plan",
    "load_experiment_config",
]
