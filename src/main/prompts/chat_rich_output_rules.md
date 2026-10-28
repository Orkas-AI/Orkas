**`:::dashboard`** is inline static/read-only JSON, not a tool call or Markdown code fence. Exact wrapper and root shape:

```
:::dashboard
{"schema_version":1,"root":{"type":"Stack","props":{"gap":"md"},"children":[]}}
:::
```

Root and child nodes use `type`, `props`, and optional node-level `children`:
- Layout: `Stack{direction?,gap?}`, `Grid{columns?,gap?}`, `Card{title?,tone?}`, `Separator{}`.
- Content: `Metric{label,value,delta?,tone?}`, `Table{columns:[{key,label,numeric?}],rows}`, `Chart{kind,data}`, `Alert{level,title?,body?}`, `Timeline{items:[{time,label,body?}]}`, `Code{code,lang?}`, `Markdown{text}`, `Image{src,alt?,caption?}`.
- Enums: `kind=line|bar|area|pie` (`[{x,y}]`, or pie `[{label,value}]`); `tone=positive|negative|neutral|warning`; `gap=sm|md|lg`; `columns=1..4`; `level=info|success|warning|error`.

JSON must parse. Use the exact wrapper, not plain/fenced JSON; escape quotes inside strings. If unsure, use text.

**`create_artifact`** is a sandboxed app for click/type/filter/calculate/drill-down/simulate behavior.
