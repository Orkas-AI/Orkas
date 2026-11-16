---
name: social-publish
description_zh: 使用可见浏览器把已准备好的内容填入社媒平台后台，保存草稿或停在发布前确认页；支持标题、正文、标签、话题、图片、视频、封面、分类等字段；禁止自动点击最终发布；适合“保存成公众号草稿”“填到小红书草稿”“放进 X 发帖框但不要发布”
description_en: Use a visible browser to place prepared content into a social platform editor, save a draft, or stop at the pre-publish confirmation page. Supports title, body, tags, topics, images, videos, cover, category, and similar fields. Never clicks final publish automatically.
---

# Social Publish

## When to Use

Use this skill when the user already has prepared content and wants help placing it into a platform editor.

Use for:

- filling title, body, tags, topics, summary, category, cover, images, or videos.
- saving a draft when the platform supports drafts.
- stopping on the editor or final confirmation page when drafts are unavailable.
- helping the user finish manual review before they publish themselves.

Do not use this skill to write or optimize the content. Resolve requested writing or revisions before preparing the platform editor.

## Hard Safety Boundary

This skill must not click final irreversible actions, including:

- publish, post, send, submit, create topic, submit for review, pay, boost, advertise, or equivalent controls.
- accepting original/advertising/legal declarations without user confirmation.
- bypassing login, CAPTCHA, SMS, 2FA, platform risk control, paid features, or account limits.

The final publish action must be performed manually by the user.

## Tools And Capabilities

This skill depends on visible browser automation and local file access:

- visible browser control: open pages, click, type, paste, inspect page state.
- Chrome or Edge remote debugging if required by the available browser automation tool.
- local file reading: load content from markdown/text files and verify media paths.
- clipboard or editor input: paste long articles, captions, tags, and structured fields.
- upload controls: upload images, videos, covers, or attachments when the user provided local paths.
- page state checks: re-read the page after navigation, login, upload, dialogs, or save actions.

## Workflow

1. Confirm the publishing task:
   - platform, content type, title, body source, tags/topics, media paths, cover, summary, category, author, and login state.
   - whether "save draft" is required or stopping in the editor is acceptable.
2. Prepare content:
   - read local files if requested.
   - verify image/video paths exist.
   - preserve original content; do not silently rewrite.
3. Open the platform editor:
   - use a visible browser.
   - if login, CAPTCHA, 2FA, account risk, or payment appears, stop and let the user handle it.
4. Fill fields carefully:
   - inspect the page before interacting.
   - fill one field at a time.
   - upload media and wait for completion before continuing.
   - after page changes, inspect again and avoid stale element references.
5. Handle platform-specific choices:
   - ask the user for ambiguous declarations, category choices, copyright/original settings, ad labels, cover cropping, or paid promotion.
   - do not guess high-impact settings.
6. Stop safely:
   - save draft if available and verify the save state when possible.
   - otherwise stop in the editor or pre-publish confirmation page.
   - explicitly report which final action was not clicked.

## Platform Scope

Stable or expected targets:

- Xiaohongshu: image/text/long-form draft preparation.
- WeChat Official Account: article draft preparation.
- X: compose box preparation, draft/stop before post.
- Zhihu: answer/post/idea preparation.
- Weibo: compose preparation; may need to stop in editor if draft support is weak.
- Juejin: article draft preparation.
- Linux.do: topic draft preparation; stop before creating topic.

Other platforms can be attempted only after inspecting the actual page flow.

## Return Format

```markdown
# Social Publish Result

## Status
Success / Partial success / Failed / Stopped for manual confirmation

## Platform And Content
Platform:
Content type:
Title:
Media:

## Completed
- ...

## Needs User Confirmation
- ...

## Final Actions Not Performed
- ...

## Risks Or Errors
- ...

## Current Page State
- ...
```

## Dependencies

- Visible browser automation must be available.
- The user must provide or complete platform login.
- Local files and media paths must be accessible.
- Platform UI may change and require re-inspection.

## Limits

- Never click final publish or equivalent irreversible controls.
- Do not bypass security, login, risk checks, or paid capabilities.
- Do not guarantee draft persistence, platform review, moderation, reach, or account status.
