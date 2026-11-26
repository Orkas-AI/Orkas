export const TASK_NOTE_MAX = 300;

/** Match the Server's character bound without splitting a surrogate pair. */
export function taskNoteLimitEnd(note: string): number {
  if (note.length <= TASK_NOTE_MAX) return note.length;
  let count = 0;
  let end = 0;
  for (const character of note) {
    end += character.length;
    if (++count === TASK_NOTE_MAX) break;
  }
  return end;
}

export function isTaskNoteWithinLimit(note: string): boolean {
  return taskNoteLimitEnd(note) === note.length;
}
