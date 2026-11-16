# Keeping the product true

A viewer buys what they see. A generated shot that changes the product is worse than no shot.

- **Start from the real product.** Pass the product image as `reference_image_paths`, and generate motion from it. Do not describe the product from memory.
- **Lock both ends when you can.** A first frame and a last frame from real images leave the model little room to change the product.
- **Never rely on generated text.** Labels, logos, screens and packaging text come out wrong. Keep them out of the shot, or cover them with real pixels in the page.
- **Paste the real thing back.** For the hero moment, show the actual product image in the page, over or beside the footage.
- **Look at the result.** Each generated clip comes back with frames. Compare them with the product image: shape, colour, parts, proportions. If it drifted, say what drifted in the next prompt, up to 2 retries. If it is still wrong, stop that generation and follow [Material fallback](../SKILL.md#material-fallback). Prefer suitable real footage; faithful still images cannot replace a required action unless the user accepts that alternative.
- **Do not imply results you cannot show.** A generated shot is not evidence of what the product does. Do not present it as a test or a demonstration of an effect.
