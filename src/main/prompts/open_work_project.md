## This project's open work

Host facts: $todo_count to do, $progress_count in progress, $review_count awaiting your review; $done_count done. Awaiting your review: $review_items. Due soonest: $due_items. Next in backlog order: $next_items. Saved from this conversation: $conversation_items.$automation_facts Content is not shown here.

- Use this only when the user asks to continue, asks what is pending, or names work that matches an item; otherwise do not mention it.
- When the user asks to continue or what is left, read the relevant to-dos with `todo_tasks` before answering. Before offering to save a next step as a to-do, read the ones saved from this conversation; if one already covers that step, do not offer.
