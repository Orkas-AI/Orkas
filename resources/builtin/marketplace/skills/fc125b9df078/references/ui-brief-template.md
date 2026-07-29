# UI Brief Template

Use this when the user wants UI direction before implementation, or asks for JSON/Markdown handoff.

## JSON Brief

```json
{
  "meta": {
    "version": "1.0",
    "date": "<YYYY-MM-DD>",
    "sources": []
  },
  "purpose": {
    "product_goal": "",
    "user_problem": "",
    "success_metrics": []
  },
  "audience": {
    "primary": "",
    "secondary": "",
    "context": ""
  },
  "ui_direction": {
    "style_reference": "",
    "tone": "",
    "density": "",
    "platforms": []
  },
  "design_system": {
    "existing_tokens": [],
    "existing_components": [],
    "proposed_components": []
  },
  "screens": [
    {
      "name": "",
      "purpose": "",
      "sections": [],
      "states": ["default", "empty", "loading", "error", "success"]
    }
  ],
  "a11y": {
    "contrast": "",
    "keyboard": "",
    "focus": "",
    "touch_target": "44px",
    "rtl_multilingual": ""
  },
  "open_questions": []
}
```

## Markdown Brief

```markdown
# UI Brief: [Feature / Screen]

## Inputs
| Source | What It Contributes | Confidence | Notes |
|---|---|---|---|
| [Source material] | [Goal / users / constraints / app context] | High / Medium / Low | |

## Product Goal
- Goal:
- Target users:
- Primary workflow:
- Success metric:

## UI Direction
- Style reference:
- Tone:
- Density:
- Platform:

## Screens And States
| Screen / Component | Purpose | Key States | Notes |
|---|---|---|---|
| | | Default / Empty / Loading / Error / Success | |

## Component Mapping
| Need | Existing Component | Proposed Component | Notes |
|---|---|---|---|
| | | | |

## Accessibility And Responsive Rules
- Contrast:
- Keyboard/focus:
- Touch target:
- Mobile behavior:
- Desktop behavior:

## Implementation Notes
- Files or areas likely affected:
- Styling constraints:
- Verification needed:

## Open Questions
- [ ] [Question] - Owner:
```
