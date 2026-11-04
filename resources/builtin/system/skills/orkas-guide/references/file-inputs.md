# Local file inputs

## Choose where the file belongs

- Use a task attachment when the file is needed only in the current
  conversation.
- Use **Library** when a supported source should be reusable across later
  tasks.
- Use a Project Library when the supported source belongs to one ongoing
  Project.

Task files do not sync with their task to another device. When a supported
file should be reusable or available through cloud sync (commercial edition only), add it to the global
or Project Library and let Library processing and sync finish.

Saving a reply opens a location picker whose title names the Project or global
Library. Its destination line repeats that Library before the selected folder;
check both parts before confirming the save.

When **Add to Library** is used on a file produced inside a Project task,
Orkas saves it to that Project's Library. The same action in a task outside a
Project saves it to the global Library. The success message identifies the
destination. A processing indicator can remain while the file is indexed; if
the app closes during that work, reopening the Project Library resumes the
interrupted indexing instead of leaving it permanently in progress.

The current file picker and its visible error are authoritative when a format
is not listed below or the account/build differs.

## Supported input boundary

Task attachments accept text and code files, PDF, modern Word/Excel/PowerPoint,
legacy Excel (.xls), common raster images, video, and audio. They also accept a ZIP only as an
opaque, path-only input for the dedicated Skill-package importer: the archive
body is not added to model context. To import a Skill ZIP, attach it in
**Commander** and explicitly ask Orkas to import that Skill. Library accepts
text and code files, PDF, modern Word/Excel/PowerPoint, legacy Excel (.xls),
and common raster images. Project Library also accepts common video files.

Legacy Excel input supports reading cell data and a content preview. It does
not run macros or recalculate formulas; save updated formula results in Excel
before importing when current calculations matter.

When a reply is already running, a completed task attachment can remain on the
new message while that message waits in the task's send queue. An attachment
that is still uploading must finish before the message can be sent or queued.

ZIP is not ordinary document context, and Library or Project Library does not
accept it. Other archive formats are not accepted through these entry points.
For ordinary source material, ask the user to extract the archive on their
device and add the relevant supported files. Use the dedicated setup flow for
an Agent, connector, or other package instead of treating its archive as task
context.

## Choose the working folder

Use the **Workspace** chip in a task composer to choose the folder where Orkas
and the selected Agent may work. **Default** uses Orkas's managed workspace;
**Pick folder...** selects a user folder, and **Open folder...** reveals the
current one. A Project keeps its own Workspace choice across Project tasks.
Choose only a folder that the task should be able to read or change; the active
tool-permission mode still applies. Attaching a file does not change the
Workspace.

## Add a supported file

1. Open the target task, **Library**, or Project Library.
2. Choose its visible add/attach action.
3. Select only the source files needed for the task.
4. Wait for the item to finish importing or indexing before relying on it.
5. In a task composer, click a completed attachment chip to preview it before
   sending, or use its remove control if it is the wrong file.
6. In the task, state what Orkas should do with the file.

If a file is rejected, keep the source unchanged, convert or extract it outside
Orkas into a supported format, and retry with the converted file.
