# Optional copy constructor

When repeated factual passages would benefit from exact reuse, the
[copy constructor](../scripts/compose_copy.py) can insert complete source-bearing
statements into a layout. Keep subject, quantity, conditions and uncertainty in
the statement itself. Translate it with the same meaning before reuse. Literal
parts supply layout and creative prose; they receive the same editorial revision
as referenced statements. The constructor preserves text, not truth.

Use direct writing for a simple deliverable and the constructor when reuse helps;
normal tools remain available in either route. The composition JSON is working
material. When using it, edit and reassemble the composition before delivering
the resulting file through the existing output tools.

The constructor uses the existing Python runtime, no service or installation:

```sh
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" ecommerce-listing compose_copy -- copy.json --output result.md
```

The JSON has exactly `statements` and `parts`. Statements are keyed by your
local IDs, each with `text` and `source` strings. Parts are literal strings or
`{"ref":"statement-id"}` objects, in delivery order. Include formatting and
spacing explicitly; the constructor does not infer a layout, translate, rewrite
or execute embedded content.

```json
{
  "statements": {
    "availability": {
      "text": "Studio visits are available on Saturdays by appointment.",
      "source": "studio-brief.md / visits"
    }
  },
  "parts": [
    "## Come meet the makers\n\n",
    {"ref": "availability"},
    "\n\nChoose a time to explore the studio with us.\n"
  ]
}
```
