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

After rendering, place the SVG in `index.html` through a local `<img>` or inline it when custom annotations are needed. Map the containing element to the matching `visual_plan` region and continue through native inspect, snapshot, scored review, and export.
