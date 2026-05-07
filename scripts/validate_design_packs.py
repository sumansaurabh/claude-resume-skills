#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PACKS_DIR = ROOT / "design-packs"
PACK_DIR_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}-")

ARCHETYPE_REQUIRED_FILES = {
    "system-design": {
        "README.md",
        "manifest.json",
        "00-question-and-context.md",
        "01-executive-summary.md",
        "02-architecture.md",
        "03-api-and-contracts.md",
        "04-low-level-design.md",
        "05-scaling-and-capacity.md",
        "06-security-and-isolation.md",
        "07-reliability-observability-and-failures.md",
        "08-tradeoffs-and-alternatives.md",
        "09-cross-questions.md",
        "10-cheat-sheet.md",
    },
    "security-review": {
        "README.md",
        "manifest.json",
        "00-question-and-context.md",
        "01-executive-summary.md",
        "02-vulnerability-classes.md",
        "03-tooling-and-configuration.md",
        "04-threat-model-connection.md",
        "05-cross-questions.md",
        "06-cheat-sheet.md",
    },
}

CROSS_EXAM_REQUIRED_FILES = {
    "README.md",
    "api-and-lld-pushback.md",
    "scale-stressors.md",
    "security-pushback.md",
    "leadership-and-business-pushback.md",
    "fast-rebuttals.md",
}

BANNED_ROOT_FILES = {
    "11-api-and-lld-pushback.md",
    "12-scale-stressors.md",
    "13-security-pushback.md",
    "14-leadership-and-business-pushback.md",
    "15-fast-rebuttals.md",
}

REQUIRED_MANIFEST_KEYS = {
    "schemaVersion",
    "archetype",
    "slug",
    "createdAt",
    "question",
    "questionHash",
    "company",
    "primarySkill",
    "sourceFiles",
    "grounding",
}


def normalize_question(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def compute_question_hash(text: str) -> str:
    digest = hashlib.sha256(normalize_question(text).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def validate_manifest(pack_dir: Path) -> tuple[dict | None, list[str]]:
    errors: list[str] = []
    manifest_path = pack_dir / "manifest.json"

    if not manifest_path.exists():
        return None, [f"missing manifest.json in {pack_dir.name}"]

    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as exc:
        return None, [f"invalid manifest.json in {pack_dir.name}: {exc}"]

    missing_keys = sorted(REQUIRED_MANIFEST_KEYS - manifest.keys())
    if missing_keys:
        errors.append(f"{pack_dir.name}: manifest missing keys {', '.join(missing_keys)}")

    archetype = manifest.get("archetype")
    if archetype not in ARCHETYPE_REQUIRED_FILES:
        errors.append(f"{pack_dir.name}: unsupported archetype {archetype!r}")

    slug = manifest.get("slug")
    if isinstance(slug, str) and not pack_dir.name.endswith(slug):
        errors.append(f"{pack_dir.name}: folder name does not end with slug {slug!r}")

    created_at = manifest.get("createdAt")
    if isinstance(created_at, str) and pack_dir.name[:10] != created_at:
        errors.append(f"{pack_dir.name}: createdAt {created_at!r} does not match folder date prefix")

    question = manifest.get("question")
    question_hash = manifest.get("questionHash")
    if isinstance(question, str) and isinstance(question_hash, str):
        expected_hash = compute_question_hash(question)
        if question_hash != expected_hash:
            errors.append(
                f"{pack_dir.name}: questionHash mismatch, expected {expected_hash} got {question_hash}"
            )

    source_files = manifest.get("sourceFiles")
    if isinstance(source_files, list):
        for source_file in source_files:
            if not isinstance(source_file, str) or not (ROOT / source_file).exists():
                errors.append(f"{pack_dir.name}: source file missing or invalid: {source_file!r}")
    else:
        errors.append(f"{pack_dir.name}: sourceFiles must be a list")

    grounding = manifest.get("grounding")
    if not isinstance(grounding, dict):
        errors.append(f"{pack_dir.name}: grounding must be an object")
    else:
        confidence = grounding.get("confidence")
        if confidence not in {"high", "medium", "low"}:
            errors.append(f"{pack_dir.name}: grounding.confidence must be high, medium, or low")
        for key in ("strongAnchors", "supportingAnchors"):
            if not isinstance(grounding.get(key), int):
                errors.append(f"{pack_dir.name}: grounding.{key} must be an integer")

    return manifest, errors


def validate_files(pack_dir: Path, manifest: dict) -> list[str]:
    errors: list[str] = []
    archetype = manifest["archetype"]
    required_files = ARCHETYPE_REQUIRED_FILES[archetype]
    root_files = {path.name for path in pack_dir.iterdir() if path.is_file()}

    missing_files = sorted(required_files - root_files)
    if missing_files:
        errors.append(f"{pack_dir.name}: missing required files {', '.join(missing_files)}")

    banned_files = sorted(BANNED_ROOT_FILES & root_files)
    if banned_files:
        errors.append(
            f"{pack_dir.name}: cross-exam files must move to cross-exam/: {', '.join(banned_files)}"
        )

    cross_exam_dir = pack_dir / "cross-exam"
    if cross_exam_dir.exists():
        if not cross_exam_dir.is_dir():
            errors.append(f"{pack_dir.name}: cross-exam exists but is not a directory")
        else:
            cross_exam_files = {path.name for path in cross_exam_dir.iterdir() if path.is_file()}
            missing_cross_exam = sorted(CROSS_EXAM_REQUIRED_FILES - cross_exam_files)
            if missing_cross_exam:
                errors.append(
                    f"{pack_dir.name}: cross-exam missing files {', '.join(missing_cross_exam)}"
                )

    return errors


def iter_pack_dirs() -> list[Path]:
    return sorted(
        path
        for path in PACKS_DIR.iterdir()
        if path.is_dir() and PACK_DIR_PATTERN.match(path.name)
    )


def main() -> int:
    pack_dirs = iter_pack_dirs()
    if not pack_dirs:
        print("No design packs found.")
        return 0

    errors: list[str] = []
    for pack_dir in pack_dirs:
        manifest, manifest_errors = validate_manifest(pack_dir)
        errors.extend(manifest_errors)
        if manifest is None:
            continue
        errors.extend(validate_files(pack_dir, manifest))

    if errors:
        print("Design pack validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"Validated {len(pack_dirs)} design pack(s) successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())