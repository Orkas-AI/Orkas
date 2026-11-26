# Structured zero-call visuals

Use the private `structured_visual` script when the request is primarily a diagram or quantitative chart. It writes static SVG and makes zero model calls.

## Shared envelope

```json
{
  "schema_version": 1,
  "kind": "diagram",
  "canvas": { "width": 1200, "height": 675 },
  "title": "One visible argument",
  "subtitle": "Optional concise context",
  "theme": {
    "background": "#f4f0e8",
    "surface": "#fffdf8",
    "text": "#18171c",
    "muted": "#696773",
    "grid": "#d9d2c7",
    "accents": ["#6558d3", "#119b78", "#e39b37"],
    "font_family": "Inter, ui-sans-serif, system-ui, sans-serif"
  }
}
```

Choose a subject-specific palette instead of reusing these example colors. Keep titles short enough to remain legible at thumbnail size.

## Diagram

```json
{
  "schema_version": 1,
  "kind": "diagram",
  "canvas": { "width": 1200, "height": 675 },
  "title": "From intent to approved image",
  "diagram": {
    "direction": "LR",
    "nodes": [
      { "id": "brief", "label": "Lock the brief", "detail": "purpose + audience" },
      { "id": "make", "label": "Compose or generate" },
      { "id": "review", "label": "Review evidence", "detail": "signature bound" }
    ],
    "edges": [
      { "from": "brief", "to": "make" },
      { "from": "make", "to": "review", "label": "current pixels" }
    ]
  }
}
```

Use `direction:"TB"` for top-to-bottom flow. The script derives stable DAG levels; set an integer `level` on a node only when the intended grouping is otherwise ambiguous. Keep node count below the cognitive limit of the final canvas, even though the schema accepts up to 40.

## Bar or line chart

```json
{
  "schema_version": 1,
  "kind": "bar",
  "canvas": { "width": 1200, "height": 675 },
  "title": "Generation calls avoided",
  "chart": {
    "labels": ["Poster", "Chart", "Photo"],
    "series": [
      { "name": "Zero-call", "values": [1, 1, 0], "color": "#119b78" },
      { "name": "Generated", "values": [0, 0, 1], "color": "#6558d3" }
    ]
  }
}
```

Change `kind` to `line` for ordered trends. Use honest scales and preserve the user's units in the surrounding HTML or subtitle.

## Donut chart

Use one series. Labels and values must have equal lengths and values must total more than zero.

```json
{
  "schema_version": 1,
  "kind": "donut",
  "canvas": { "width": 1200, "height": 675 },
  "title": "Production route mix",
  "chart": {
    "labels": ["Compose", "Hybrid", "Generate"],
    "series": [{ "name": "Share", "values": [55, 25, 20] }]
  }
}
```

## Place and deliver

If the SVG contains any `brief.required_copy`, paste the generated `<svg>…</svg>` markup into `index.html` so the native snapshot can check the visible text in the page DOM. Use a local `<img>` for supporting SVGs when the page already contains all required copy as visible text.

Remove the default page margin and size the SVG to fit its `visual_plan` region within the manifest's fixed canvas. Follow the [native workflow](../SKILL.md#native-workflow) to snapshot the HTML, review that snapshot, and export in a supported format such as PNG. Keep the generated `.svg` as an editable source file when requested.
