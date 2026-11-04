---
name: orkas-guide
description: "Resolve Orkas support, usage conditions, credits and costs, configuration, operation and recovery facts for questions or actions, including implicit product assumptions. Not for Orkas-independent content; supplies facts, not task ownership or operation authority."
---

# Orkas Guide

Establish the Orkas product facts needed to answer or carry out the user's request. Use the relevant references and current app/tool evidence to determine what is supported and where it is available, whether the request is a question or an instruction to act.

Do not load it merely because requested work happens inside Orkas. Leave creation, editing, installation, and other work to the matching owner; this guide supplies product facts needed for that work. It does not authorize an operation or prove that one succeeded.

Judge support against the requested outcome, not merely whether a resource can be created. If the documented workflow cannot achieve an outcome, say that explicitly before offering an alternative or carrying out the supported part. If evidence is incomplete, state what remains unconfirmed instead of inventing a setting, configuration field, or workaround. An alternative must state which part of the requested outcome it achieves and which part remains unmet.

## Editions

This guide covers the commercial and open-source editions of Orkas. **Commercial edition only** identifies a product boundary, not a requirement for paid membership. Shared local features and user-owned provider credentials remain available in the open-source build; its **Settings** entry replaces the commercial sidebar's **Account settings** path. It has no Orkas desktop sign-in or account/membership page. The edition availability table in [editions.md](references/editions.md) distinguishes account-funded services from provider OAuth and the separate Orkas API Key service. Installed versions can differ; the current controls and tool capabilities determine availability.

## Choose the relevant guide

Read only the references needed for the product facts at issue:

| Product facts needed | Reference |
|---|---|
| Distinguish commercial-only features from the open-source build and user-owned provider/API access | [editions.md](references/editions.md) |
| Understand Orkas, choose features for ongoing work, find the main areas, or complete a first task | [getting-started.md](references/getting-started.md) |
| Start, guide, monitor, stop, retry, revisit, or share a task or its result | [tasks-and-conversations.md](references/tasks-and-conversations.md) |
| Attach, import, or reuse a local file, choose a working folder, or check whether a file format such as ZIP is supported | [file-inputs.md](references/file-inputs.md) |
| Organize ongoing work in a Project or schedule it with Auto | [projects-and-automation.md](references/projects-and-automation.md) |
| Choose an agent or skill, or connect an external service | [agents-skills-and-connectors.md](references/agents-skills-and-connectors.md) |
| Reuse saved material, search across Orkas, or open a saved app | [library-search-and-apps.md](references/library-search-and-apps.md) |
| Configure or choose models, understand whether model/permission settings apply to a task, Agent, or Skill; credits, membership, memory, sync, account data, deletion, notifications, voice input, or app updates | [settings-data-and-safety.md](references/settings-data-and-safety.md) |
| Recover from a common blocked, failed, missing, or disconnected state | [common-recovery.md](references/common-recovery.md) |

For a broad “what can Orkas do?” question, start with `getting-started.md`, then read only the reference for the area the user wants to explore.

## Choose the support shape

- **Explain:** answer a factual “what/how/where” question with the shortest visible path.
- **Navigate:** when an exact supported destination is available, pair the path with the app's click-to-open affordance. Do not invent a destination or claim that the screen opened before the user clicks.
- **Diagnose:** for a reported blocked, failed, disconnected, or stuck state, inspect the smallest available sanitized app-status domain before choosing recovery. Never ask for or expose credentials, local paths, provider error text, or user content.
- **Execute:** supply the relevant product facts, prerequisites, visible results, and recovery for the requested operation.
- **Verify:** describe an operation as complete only after its owning workflow returns success evidence; navigation and diagnostic results are not mutation evidence.

## Shape the answer

1. Identify the outcome the user wants.
2. Lead with the supported outcome or relevant limitation, then the shortest documented path when one exists.
3. Give three to seven ordered actions when a procedure is needed.
4. Mention availability, permissions, credits, or data consequences only when they affect this action.
5. Add the relevant recovery step only if the normal path may be blocked.
6. Answer in the user's language while preserving useful visible labels such as **Commander**, **Projects**, **Auto**, or **Account settings**.

Treat every independently named control or action in the selected reference as required coverage before adding recommendations. In particular, an explanation of the task composer's model control must explicitly say that the user can **view models**, **switch models**, and open **Configure models** to **add a model**; do not collapse those three actions into “select” or “manage”.

For a simple “where is this?” question, one or two sentences are enough.

## Coverage

- Cover normal product use and common recovery for Orkas's core workflows.
- For a connected service, explain the Orkas part of the workflow and point the user to that service for its own administration or advanced setup.
- Describe only actions supported by the current Orkas experience. If availability differs by account, region, device, or current catalog, tell the user where to confirm it in Orkas.
- Distinguish pausing or disconnecting something from deleting its data.
- Treat broader tool permission as a deliberate safety choice, not a generic troubleshooting step.

## Preferred response

Use only the sections that help:

- **Path:** where to begin.
- **Steps:** what to do.
- **Note:** a material availability or safety condition.
- **If blocked:** the next recovery action.
