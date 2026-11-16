/** Optional creative preferences, not final-file requirements. */
import { z } from 'zod';

export const taskOutputSchema = z.object({
    aspect: z.enum(['1:1', '4:5', '9:16', '16:9', '3:2']).optional(),
    format: z.enum(['png', 'jpg', 'webp', 'pdf', 'psd', 'mp4', 'wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'txt', 'srt', 'json']).optional(),
}).strict();
export type TaskOutput = z.infer<typeof taskOutputSchema>;
const formats = {
    image: ['png', 'jpg', 'webp', 'pdf', 'psd'], video: ['mp4'],
    audio: ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus'], text: ['txt', 'srt', 'json'],
};
export function validTaskOutput(kind: string | undefined, output: unknown): output is TaskOutput {
    if (!kind || !Object.hasOwn(formats, kind) || !taskOutputSchema.safeParse(output).success) return false;
    const value = output as TaskOutput;
    return (!value.aspect || kind === 'image' || kind === 'video')
        && (!value.format || formats[kind].includes(value.format));
}
