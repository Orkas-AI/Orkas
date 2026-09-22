"""Assemble UTF-8 copy from literal prose and reusable source-bearing statements.

This is an offline document constructor, not a fact checker. It neither calls a
model nor interprets prose. Statement truth and creative implications remain
the writer's responsibility. See references/source-based-writing.md.
"""
import argparse
import json
import os
from pathlib import Path
import tempfile


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key; use distinct statement IDs.")
        result[key] = value
    return result


def compose(document):
    """Resolve references once, preserving literal text, Unicode and conditions."""
    if not isinstance(document, dict) or set(document) != {"statements", "parts"}:
        raise ValueError("Expected statements and parts.")
    statements, parts = document["statements"], document["parts"]
    if not isinstance(statements, dict) or not isinstance(parts, list):
        raise ValueError("Statements must be an object and parts must be an array.")
    for key, statement in statements.items():
        if not isinstance(key, str) or not key or not isinstance(statement, dict):
            raise ValueError("Each statement needs a distinct nonempty ID.")
        if set(statement) != {"text", "source"} or not all(
            isinstance(statement[field], str) and statement[field].strip()
            for field in ("text", "source")
        ):
            raise ValueError("Each statement needs nonempty text and source strings.")
    output, used = [], set()
    for part in parts:
        if isinstance(part, str):
            output.append(part)
        elif isinstance(part, dict) and set(part) == {"ref"}:
            ref = part["ref"]
            if not isinstance(ref, str) or ref not in statements:
                raise ValueError("Unresolved statement reference.")
            output.append(statements[ref]["text"])
            used.add(ref)
        else:
            raise ValueError("Each part must be literal text or a ref object.")
    return "".join(output), len(used)


def write_copy(source, destination):
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve():
        raise ValueError("Copy output must differ from its source document.")
    document = json.loads(source.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    text, count = compose(document)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="",
                                         dir=destination.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(text)
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"characters": len(text), "statements_used": count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Composition JSON")
    parser.add_argument("--output", required=True, help="Text or Markdown output")
    args = parser.parse_args()
    try:
        result = write_copy(args.source, args.output)
    except (OSError, ValueError):
        parser.exit(1, "Copy assembly failed; check JSON, references and file access.\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
